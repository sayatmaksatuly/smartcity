"""A bounded conversational adapter over the existing, grounded recommendation pipeline.

No transcript is retained by the server or sent to Gemini. Client state is untrusted:
preferences have strict bounds and every selected/restored/origin POI is read from SQLite.
"""

import re

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import POI
from app.schemas import (
    Category,
    ChatContext,
    ChatPreferences,
    ChatRequest,
    ChatResponse,
    ChatSnapshot,
    POIOut,
    Position,
    RecommendationRequest,
)
from app.services.importer import fold
from app.services.intent import CATEGORY_PATTERNS, find_named_origins, mentions, parse_intent, text_duration
from app.services.recommendations import recommend

MORE = r"\b(?:ещ[её]\s+вариант\w*|покажи\s+ещ[её]|друг\w*|more|another|басқа)\b"
PREVIOUS = r"\b(?:предыдущ\w*|верн[её]мся|назад|previous|back)\b"
NEARBY = r"\b(?:поближе|ближе|поблизости|nearer|closer|жақын)\b"
ORIGIN = r"\b(?:возле|около|рядом\s+с|near|by|у(?!\s+меня\b))\s+|\b(?:жанында|қасында)\b"
BEAUTIFUL = r"\b(?:красив\w*|красот\w*|фотограф\w*|видов\w*|beautiful|көрікті)\b"
GENERAL = r"\b(?:куда|вариант\w*|покажи|подбер\w*|посовет\w*|интересн\w*|мест[аоу]?|recommend)\b"
CATEGORY_QUERY = {
    Category.park: "парк",
    Category.cafe: "кафе",
    Category.culture: "музей",
    Category.landmark: "достопримечательности",
    Category.recreation: "спорт",
    Category.venue: "библиотека",
}


def resolve_preferences(request: ChatRequest, context: ChatContext) -> tuple[ChatPreferences, bool]:
    preferences = context.preferences.model_copy(deep=True)
    # Explicit controls supersede older dialogue; the fresh message can refine them.
    changes = request.overrides.model_dump(exclude_none=True)
    for key, value in changes.items():
        setattr(preferences, key, value)
    if "categories" in changes:
        preferences.excluded_categories = [
            c for c in preferences.excluded_categories if c not in preferences.categories
        ]
    baseline = preferences.model_copy(deep=True)
    query = fold(request.message)
    parsed = parse_intent(RecommendationRequest(position=Position(lat=0, lon=0), query=query))
    if any(mentions(query, pattern) == (True, True) for pattern in CATEGORY_PATTERNS.values()):
        return baseline, False
    duration = text_duration(query)
    if duration:
        preferences.duration_minutes = duration
    explicit_positive = [category for category, pattern in CATEGORY_PATTERNS.items() if mentions(query, pattern)[0]]
    beautiful = mentions(query, BEAUTIFUL)[0]
    inferred = list(parsed.categories)
    if beautiful and Category.landmark not in inferred:
        inferred.append(Category.landmark)
    if inferred:
        if re.search(r"\b(?:добав\w*|также|тоже|also|add)\b", query):
            preferences.categories = list(dict.fromkeys(preferences.categories + inferred))
        else:
            preferences.categories = inferred
    excluded = [c for c in preferences.excluded_categories if c not in explicit_positive]
    excluded.extend(parsed.excluded)
    preferences.excluded_categories = list(dict.fromkeys(excluded))
    preferences.categories = list(dict.fromkeys(c for c in preferences.categories if c not in excluded))
    for key, pattern in (
        ("free_only", r"\b(?:бесплат\w*|free|тегін)"),
        ("open_now", r"\b(?:открыто сейчас|открыт\w* сейчас|open now|қазір ашық)"),
    ):
        positive, negative = mentions(query, pattern)
        if positive or negative:
            setattr(preferences, key, positive and not negative)
    if parsed.walking:
        preferences.walking = True
    if parsed.relaxing:
        preferences.relaxing = True
    if parsed.outdoor:
        preferences.outdoor = True
    if parsed.artwork:
        preferences.artwork = True
    if parsed.sightseeing or beautiful:
        preferences.sightseeing = True
    if re.search(NEARBY, query):
        preferences.prefer_nearby = True
    if re.search(r"\b(?:велосипед\w*|cycling|bike)\b", query):
        preferences.travel_mode = "cycling"
    elif re.search(r"\b(?:пешком|пеш[а-я]*|walking)\b", query):
        preferences.travel_mode = "walking"
    recognized = bool(
        duration
        or inferred
        or parsed.excluded
        or parsed.free
        or parsed.open_now
        or re.search(f"{MORE}|{PREVIOUS}|{NEARBY}|{ORIGIN}|{GENERAL}", query)
        or preferences != baseline
    )
    return preferences, recognized


def recommendation_request(preferences: ChatPreferences, position: Position) -> RecommendationRequest:
    """Translate typed state to known intent vocabulary, never concatenate chat history."""
    query = [CATEGORY_QUERY[c] for c in preferences.categories]
    query.extend("без " + CATEGORY_QUERY[c] for c in preferences.excluded_categories)
    if preferences.walking and Category.park in preferences.categories:
        query.append("прогулка")
    if preferences.relaxing:
        query.append("отдохнуть")
    if preferences.outdoor:
        query.append("на свежем воздухе")
    if preferences.artwork and Category.landmark in preferences.categories:
        query.append("скульптура")
    return RecommendationRequest(
        position=position,
        query="; ".join(query),
        duration_minutes=preferences.duration_minutes,
        categories=preferences.categories,
        travel_mode=preferences.travel_mode,
        round_trip=preferences.round_trip,
        open_now=preferences.open_now,
        free_only=preferences.free_only,
    )


def chat(session: Session, request: ChatRequest, settings: Settings) -> ChatResponse:
    context = request.context.model_copy(deep=True) if request.context else ChatContext()
    old_preferences = context.preferences.model_copy(deep=True)
    preferences, recognized = resolve_preferences(request, context)
    context.preferences = preferences
    position = request.position
    query = fold(request.message)

    def respond(message: str, action: str, **kwargs) -> ChatResponse:
        return ChatResponse(
            message=message,
            action=action,
            context=context,
            position=position,
            selected_poi_id=context.selected_poi_id,
            **kwargs,
        )

    if any(mentions(query, pattern) == (True, True) for pattern in CATEGORY_PATTERNS.values()):
        return respond(
            "В сообщении один и тот же интерес одновременно выбран и исключён. Уточните предпочтение; остальные условия сохранены.",
            "unsupported",
        )

    # Even client-carried selected IDs may refer to refreshed/deleted data.
    # A previous action pops the navigation stack but does not erase a still-visible
    # chat message. Bounded seen IDs keep those buttons selectable; retrieval below
    # always revalidates the chosen place under current constraints.
    known_history = set(context.shown_poi_ids) | set(context.seen_poi_ids)
    for snapshot in context.snapshots:
        known_history.update(snapshot.shown_poi_ids)
    if context.selected_poi_id not in known_history or session.get(POI, context.selected_poi_id or "") is None:
        context.selected_poi_id = None

    if request.action == "confirm_origin":
        poi = (
            session.get(POI, request.confirm_origin_id)
            if request.confirm_origin_id in context.pending_origin_ids
            else None
        )
        if poi is None:
            context.pending_origin_ids = []
            return respond(
                "Старт не удалось подтвердить. Найдите место заново или выберите точку на карте.", "clarify_origin"
            )
        position = Position(lat=poi.lat, lon=poi.lon)
        context.pending_origin_ids = []
    elif request.action == "message" and re.search(ORIGIN, query):
        suggestions = find_named_origins(session, query)
        context.pending_origin_ids = [poi.id for poi in suggestions]
        if suggestions:
            return respond(
                "Нашёл возможный старт в OpenStreetMap. Подтвердите подходящее место — точка пока не изменена.",
                "confirm_origin",
                origin_suggestions=[POIOut.model_validate(poi) for poi in suggestions],
            )
        return respond(
            "Не удалось однозначно найти такой старт в базе. Выберите точку на карте или уточните название.",
            "clarify_origin",
        )

    if position is None:
        return respond(
            "Откуда планируете начать? Выберите точку на карте или напишите, возле какого места вы находитесь.",
            "clarify_origin",
        )

    restore_ids = None
    going_back = request.action == "previous" or bool(re.search(PREVIOUS, query))
    if request.action == "select":
        if request.selected_poi_id not in known_history:
            return respond(
                "Это место не найдено среди вариантов диалога. Получите новую подборку.", "previous_unavailable"
            )
        restore_ids = (request.selected_poi_id,)
    elif going_back:
        if not context.snapshots:
            return respond(
                "Предыдущей подборки пока нет. Можно изменить условия или попросить ещё варианты.",
                "previous_unavailable",
            )
        restore_ids = tuple(context.snapshots.pop().shown_poi_ids)
    elif not recognized and request.action == "message":
        return respond(
            "Я помогаю выбирать места из городской базы: могу изменить время, интересы, старт и показать другие варианты. "
            "Свободный диалог на другие темы здесь недоступен. Попробуйте «Погулять 30 минут» или «Без кафе».",
            "unsupported",
        )

    more = restore_ids is None and bool(re.search(MORE, query))
    # Preserve bounded visited IDs across refinements so visible history links stay
    # usable. A regular refinement may show them again; only "more" excludes them.
    excluded = tuple(dict.fromkeys(context.seen_poi_ids + context.shown_poi_ids)) if more else ()
    result = recommend(
        session,
        recommendation_request(preferences, position),
        settings,
        excluded_poi_ids=excluded,
        restore_poi_ids=restore_ids,
        prefer_nearby=preferences.prefer_nearby,
    )
    ids = [item.poi.id for item in result.recommendations]
    if restore_ids is not None and not ids:
        return respond(
            "Сохранённое место не подходит под текущий старт или фильтры либо больше не доступно в базе. "
            "Текущие ограничения сохранены; попросите новую подборку.",
            "previous_unavailable",
        )
    if more and not ids:
        return respond(
            "Новых вариантов под текущие условия больше не нашлось. Уже показанные места остаются на карте; "
            "можно увеличить время или изменить интересы.",
            "recommendations",
        )
    if context.shown_poi_ids and not going_back:
        context.snapshots = (
            context.snapshots + [ChatSnapshot(preferences=old_preferences, shown_poi_ids=context.shown_poi_ids)]
        )[-8:]
    context.shown_poi_ids = ids
    context.seen_poi_ids = list(dict.fromkeys(context.seen_poi_ids + ids))[-96:]
    if request.action == "select":
        context.selected_poi_id = request.selected_poi_id
    elif request.selected_poi_id in ids:
        context.selected_poi_id = request.selected_poi_id
    elif context.selected_poi_id not in ids:
        context.selected_poi_id = None
    if request.action == "select":
        message = "Место выбрано и повторно проверено по текущим условиям. Его карточка и метка доступны на карте."
        action = "selected"
    else:
        action = "recommendations"
        prefix = "Предыдущие варианты повторно проверены. " if going_back else ""
        if result.mode == "gemini":
            message = prefix + "Gemini выбрал варианты из проверенных кандидатов городской базы. " + result.message
        else:
            message = prefix + "Локальный подбор без ИИ. " + result.message
        if result.fallback_reason == "generation_failed":
            message += " Gemini сейчас недоступен или его ответ не прошёл проверку."
        if preferences.prefer_nearby and ids:
            message += " Приоритет отдан местам ближе к старту по прямой."
    return respond(message, action, recommendation_response=result)

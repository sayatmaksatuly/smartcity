"""Explainable intent parsing; explicit controls always win over text."""

import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import POI
from app.schemas import Category, RecommendationRequest
from app.services.geo import distance_m
from app.services.importer import fold, name_key

CATEGORY_PATTERNS = {
    Category.cafe: r"\b(?:кафе\w*|кофе\w*|кофейн\w*|cafe\w*|coffee|кафеге)",
    Category.park: r"\b(?:парк\w*|сквер\w*|зелени|зелен\w*|park\w*|саябақ\w*)",
    Category.culture: r"\b(?:музе\w*|галере\w*|культур\w*|museum\w*|gallery|мұражай\w*)",
    Category.landmark: r"\b(?:достопримеч\w*|архитект\w*|необычн\w*|памятник\w*|sightseeing|landmark\w*|unusual|көрікті\s+жер\w*|ерекше|скульптур\w*|artwork|sculpture)",
    Category.recreation: r"\b(?:спорт\w*|активн\w*|детск\w*|каток|sport\w*)",
    Category.venue: r"\b(?:библиотек\w*|торгов\w*|library|кітапхана\w*)",
}
WALK = r"\b(?:погуля\w*|прогуля\w*|прогул\w*|walk\w*|серуен\w*)"
RELAX = r"\b(?:спокойн\w*|отдох\w*|посид\w*|relax\w*|демал\w*)"
NEGATION = r"\b(?:не|без|кроме|нет|избег\w*|not|no|without|avoid|don't|dont|емес|қаламаймын|бармаймын)\b"
CATEGORY_LABELS = {
    "park": "парки",
    "cafe": "кафе",
    "culture": "культура",
    "landmark": "достопримечательности",
    "recreation": "активности",
    "venue": "городские места",
}


def mentions(query: str, pattern: str) -> tuple[bool, bool]:
    positive = negative = False
    for clause in re.split(r"[,;.!?]|\b(?:но|а|лучше|зато|but|instead|rather|бірақ)\b", query):
        for match in re.finditer(pattern, clause):
            prefix = re.sub(r"\b(?:не\s+только|not\s+only)\b", "", clause[: match.start()])
            suffix = clause[match.end() :]
            negated = bool(
                re.search(NEGATION, prefix)
                or re.search(r"^\s*(?:не\s+(?:хочу|надо|нужно)|емес|қаламаймын|бармаймын)\b", suffix)
            )
            negative |= negated
            positive |= not negated
    return positive, negative


def text_duration(query: str) -> int | None:
    query = re.sub(r"\b(?:полчаса|half an hour|жарты сағат)\b", "30 минут", query)
    query = re.sub(r"\b(?:полтора часа|one and a half hours)\b", "90 минут", query)
    words = {
        "один": "1",
        "одна": "1",
        "два": "2",
        "две": "2",
        "три": "3",
        "четыре": "4",
        "one": "1",
        "two": "2",
        "three": "3",
        "an": "1",
        "бір": "1",
        "екі": "2",
        "үш": "3",
    }
    query = re.sub(r"\b(?:" + "|".join(words) + r")\b", lambda m: words[m[0]], query)
    matches = list(
        re.finditer(
            r"(?<![\d.])(?:(\d+)\s*[-–—]\s*)?(\d+)\s*(мин\w*|minutes?|mins?\b|час\w*|hours?\b|hrs?\b|сағат\w*)", query
        )
    )
    values = []
    for match in matches:
        if re.search(
            r"\b(?:больше|менее|меньше|more than|less than)\s*$", query[max(0, match.start() - 18) : match.start()]
        ):
            return None
        values.append(int(match[2]) * (60 if re.match(r"час|hour|hr|сағат", match[3]) else 1))
    if values:
        value = sum(values) if len(values) == 2 and "час" in query and "мин" in query else values[0]
        return value if 15 <= value <= 240 else None
    if re.search(r"\b(?:час|hour|сағат)\b", query):
        return 60
    return None


@dataclass
class Intent:
    categories: list[Category]
    primary_categories: list[Category]
    contradictory: bool
    excluded: list[Category]
    walking: bool
    relaxing: bool
    sightseeing: bool
    artwork: bool
    free: bool
    outdoor: bool
    open_now: bool
    duration: int
    suggested_duration: int | None
    notices: list[str]

    def model_context(self):
        # No raw user text, coordinates or starting place goes to the provider.
        return {
            "categories": self.categories,
            "primary_categories": self.primary_categories,
            "excluded_categories": self.excluded,
            "walking": self.walking,
            "relaxing": self.relaxing,
            "sightseeing": self.sightseeing,
            "artwork": self.artwork,
            "free_only": self.free,
            "outdoor": self.outdoor,
            "open_now": self.open_now,
        }


def parse_intent(request: RecommendationRequest) -> Intent:
    query = fold(request.query)
    inferred, excluded, notices = [], [], []
    for category, pattern in CATEGORY_PATTERNS.items():
        positive, negative = mentions(query, pattern)
        if positive:
            inferred.append(category)
        if negative:
            excluded.append(category)
        if positive and negative:
            notices.append(
                f"В запросе одновременно выбраны и исключены {CATEGORY_LABELS[category]}. Уточните предпочтение."
            )
    primary = list(inferred)
    walking, no_walk = mentions(query, WALK)
    relaxing, _ = mentions(query, RELAX)
    outdoor, _ = mentions(query, r"\b(?:свежем воздух\w*|на улице|открытом воздух\w*|outdoors?)")
    if walking and not no_walk or outdoor:
        inferred.extend([Category.park, Category.landmark])
        primary.append(Category.park)
    if relaxing and not inferred:
        inferred.extend([Category.park, Category.cafe])
        primary.extend([Category.park, Category.cafe])
    if not inferred and mentions(query, r"\b(?:поработ\w*|work|жұмыс)")[0]:
        inferred.append(Category.cafe)
    if mentions(query, r"\b(?:турист\w*|tourist\w*)")[0]:
        inferred.append(Category.landmark)
    inferred = list(dict.fromkeys(inferred))
    if request.categories:
        categories = list(dict.fromkeys(request.categories))
        primary = categories
        if set(categories) & set(excluded) or set(inferred) - set(categories):
            notices.append(
                "Текст и выбранные интересы различаются. Используем категории из фильтра; измените их, чтобы применить запрос полностью."
            )
        excluded = [c for c in excluded if c not in categories]
    else:
        categories = [c for c in inferred if c not in excluded]
        primary = list(dict.fromkeys(c for c in primary if c not in excluded))
    free_positive, free_negative = mentions(query, r"\b(?:бесплат\w*|free|тегін)")
    open_positive, open_negative = mentions(query, r"\b(?:открыто сейчас|открыт\w* сейчас|open now|қазір ашық)")
    free = request.free_only or (free_positive and not free_negative)
    open_now = request.open_now or (open_positive and not open_negative)
    if outdoor and categories and not set(categories) & {Category.park, Category.landmark, Category.recreation}:
        notices.append(
            "Выбранные категории не подходят для условия «на улице». Сохраняем оба условия; выдача может быть пустой."
        )
    if request.free_only and free_negative or request.open_now and open_negative:
        notices.append("Текст противоречит строгому фильтру. Выбранный фильтр бесплатности/часов сохранён.")
    duration = text_duration(query)
    applied = request.duration_minutes
    suggested = None
    if duration and duration != applied:
        if "duration_minutes" in request.model_fields_set:
            suggested = duration
            notices.append(
                f"В тексте — {duration} мин, в фильтре — {applied} мин. Используем фильтр; время из текста можно подтвердить."
            )
        else:
            applied = duration
            notices.append(f"Используем время из запроса: {duration} мин.")
    if re.search(
        r"тих|спокой|поработ|розет|wi.?fi|вайфай|компани|четыр|четвер|свободн|quiet|socket|relax|тыныш|демал", query
    ):
        notices.append(
            "Тишина, свободные места, розетки и условия для компании не подтверждены. Уточните их у заведения."
        )
    if free:
        notices.append(
            "Бесплатность проверяем только по отметке fee=no в OSM; отсутствие цены не означает бесплатный вход."
        )
    if open_now:
        notices.append(
            "Фильтр часов использует простые расписания OSM по времени Астаны. Актуальность на месте не гарантируется."
        )
    if len(categories) > 1:
        notices.append(
            "Сочетаем интересы в отдельных вариантах; несколько мест не образуют рассчитанный общий маршрут."
        )
    return Intent(
        categories,
        primary,
        bool(inferred) and not categories and bool(excluded),
        excluded,
        walking and not no_walk,
        relaxing,
        Category.landmark in categories and not walking,
        bool(re.search(r"скульптур|artwork|sculpture", query)),
        free,
        outdoor,
        open_now,
        applied,
        suggested,
        notices,
    )


def aliases(poi: POI) -> set[str]:
    return {name_key(poi.name)} | {
        name_key(part)
        for key, value in poi.tags.items()
        if key == "name" or key.startswith("name:") or key in {"alt_name", "int_name"}
        for part in value.split(";")
        if part.strip()
    }


def same_place(a: POI, b: POI) -> bool:
    return a.id == b.id or (
        a.category == b.category and bool(aliases(a) & aliases(b)) and distance_m(a.lat, a.lon, b.lat, b.lon) < 35
    )


def named_interest(poi: POI, query: str) -> bool:
    query = re.sub(r"(?:\bвозле\b|\bоколо\b|\bрядом с\b|\bnear\b|\bby\b)\s+[^,;.!?]+", "", fold(query))
    names = [poi.name] + [v for k, v in poi.tags.items() if k.startswith("name:")]
    for name in names:
        if len(name_key(name)) < 4:
            continue
        pattern = r"(?<!\w)" + re.escape(fold(name)) + r"(?!\w)"
        positive, negative = mentions(query, pattern)
        if positive and not negative:
            return True
    return False


def find_named_origins(session: Session, query: str) -> list[POI]:
    """Resolve only imported names/aliases, allowing conservative Russian case suffixes."""
    query = fold(query)
    fragments = re.findall(r"(?:\bвозле\b|\bоколо\b|\bрядом с\b|\bnear\b|\bby\b|\bу\b)\s+([^,;.!?]+)", query)
    fragments += re.findall(r"([^,;.!?]+)\s+(?:жанында|қасында)", query)
    if not fragments:
        return []
    compact = set()
    for fragment in fragments:
        words = re.findall(r"\w+", fragment)
        for start in range(len(words)):
            for end in range(start + 1, min(start + 12, len(words)) + 1):
                compact.add(name_key(" ".join(words[start:end])))
    matches = []
    for poi in session.scalars(select(POI).order_by(POI.id)):
        if any(
            len(alias) >= 4
            and any(
                value == alias
                or (len(alias) >= 5 and value in {alias + suffix for suffix in ("а", "я", "у", "е", "ом", "ем")})
                for value in compact
            )
            for alias in aliases(poi)
        ) and not any(same_place(poi, previous) for previous in matches):
            matches.append(poi)
    return matches[:3]


def origin_suggestions(session: Session, request: RecommendationRequest) -> list[POI]:
    return [
        poi
        for poi in find_named_origins(session, request.query)
        if distance_m(request.position.lat, request.position.lon, poi.lat, poi.lon) >= 75
    ]

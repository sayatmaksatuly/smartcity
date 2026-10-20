import math
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import POI
from app.schemas import Category, RecommendationRequest
from app.services.geo import distance_m
from app.services.hours import availability
from app.services.intent import CATEGORY_LABELS, Intent, named_interest, parse_intent, same_place

VISIT_MINUTES = {"park": 20, "culture": 45, "landmark": 15, "cafe": 25, "recreation": 30, "venue": 25}
MATCH_TEXT = {
    "park": "Парк или сквер подходит для прогулки и паузы на улице.",
    "cafe": "Кафе подходит для перерыва за напитком; условия отдыха уточните на месте.",
    "culture": "Культурное место подходит для знакомства с городом и его историей.",
    "landmark": "Достопримечательность подходит для знакомства с городом.",
    "recreation": "Место для активного отдыха соответствует выбранному интересу.",
    "venue": "Городское место соответствует выбранному интересу.",
}


@dataclass
class Candidate:
    poi: POI
    distance: float
    travel: int
    visit: int
    total: int
    availability: str
    score: float
    reasons: list[str]
    match_text: str


def semantic_score(poi: POI, intent: Intent) -> float:
    score = 0
    if intent.walking and poi.category == "park":
        score += 20
    if intent.relaxing and poi.category in {"park", "cafe"}:
        score += 12
    if intent.sightseeing and poi.category == "landmark":
        tags = poi.tags
        score += {"attraction": 8, "viewpoint": 14, "artwork": 2}.get(tags.get("tourism"), 0)
        score += {"monument": 18, "memorial": 6}.get(tags.get("historic"), 0)
        if tags.get("wikidata") or tags.get("wikipedia") or tags.get("heritage"):
            score += 8
        if (
            tags.get("attraction")
            or tags.get("roller_coaster") == "yes"
            or tags.get("indoor") in {"yes", "room", "area"}
        ):
            score -= 12
        if intent.artwork and tags.get("tourism") == "artwork":
            score += 24
    return score


def retrieve(
    session: Session,
    request: RecommendationRequest,
    intent: Intent | None = None,
    *,
    excluded_poi_ids: tuple[str, ...] = (),
    only_poi_ids: tuple[str, ...] | None = None,
    prefer_nearby: bool = False,
) -> tuple[list[Candidate], list[Category], list[str]]:
    intent = intent or parse_intent(request)
    categories, notices = intent.categories, list(intent.notices)
    if intent.contradictory:
        return [], categories, notices
    speed = 80 if request.travel_mode == "walking" else 220
    multiplier = 2 if request.round_trip else 1
    radius = min(15_000, intent.duration * speed / (1.3 * multiplier))
    lat, lon = request.position.lat, request.position.lon
    lat_delta = radius / 111_000
    lon_delta = radius / max(1000, 111_000 * math.cos(math.radians(lat)))
    statement = select(POI).where(
        POI.lat.between(lat - lat_delta, lat + lat_delta), POI.lon.between(lon - lon_delta, lon + lon_delta)
    )
    if categories:
        statement = statement.where(POI.category.in_(categories))
    if intent.excluded:
        statement = statement.where(POI.category.not_in(intent.excluded))
    if excluded_poi_ids:
        statement = statement.where(POI.id.not_in(excluded_poi_ids))
    if only_poi_ids is not None:
        statement = statement.where(POI.id.in_(only_poi_ids))
    excluded_places = session.scalars(select(POI).where(POI.id.in_(excluded_poi_ids))).all() if excluded_poi_ids else []
    candidates = []
    for poi in session.scalars(statement):
        if any(same_place(poi, excluded) for excluded in excluded_places):
            continue
        if intent.free and poi.tags.get("fee") != "no":
            continue
        if intent.outdoor and (
            poi.category not in {"park", "landmark", "recreation"} or poi.tags.get("indoor") in {"yes", "room", "area"}
        ):
            continue
        state = availability(poi.opening_hours)
        if state == "closed" or (intent.open_now and state != "open"):
            continue
        distance = distance_m(lat, lon, poi.lat, poi.lon)
        travel = math.ceil(distance * 1.3 / speed)
        visit = VISIT_MINUTES[poi.category]
        total = travel * multiplier + visit
        if distance > radius or total > intent.duration:
            continue
        score = (
            semantic_score(poi, intent)
            + 12 / (1 + distance / 700)
            + 4 * (1 - total / intent.duration)
            + (28 if named_interest(poi, request.query) else 0)
        )
        if prefer_nearby:
            # Keep all original eligibility constraints; proximity now dominates ranking.
            score = -distance + score / 1000
        reasons = ["within_time", "nearby"]
        if categories:
            reasons.append("category_match")
        if intent.free:
            reasons.append("fee_no")
        if state == "open":
            reasons.append("hours_match")
        match_text = MATCH_TEXT[poi.category]
        if intent.walking and poi.category == "landmark":
            match_text = "Достопримечательность может стать целью короткой прогулки."
        candidates.append(Candidate(poi, distance, travel, visit, total, state, score, reasons, match_text))
    candidates.sort(key=lambda c: (-c.score, c.distance, c.poi.id))
    unique = []
    for candidate in candidates:
        if not any(same_place(candidate.poi, other.poi) for other in unique):
            unique.append(candidate)
    reserved = [next((c for c in unique if c.poi.category == cat), None) for cat in categories]
    pool = [c for c in reserved if c is not None]
    pool.extend(c for c in unique if c not in pool)
    pool = sorted(pool[:12], key=lambda c: (-c.score, c.distance, c.poi.id))
    if categories and candidates and (missing := set(categories) - {c.poi.category for c in candidates}):
        notices.append(
            "В пределах времени не найдены: "
            + ", ".join(CATEGORY_LABELS[c] for c in sorted(missing))
            + ". Остальные интересы сохранены."
        )
    return pool, categories, notices


def select_local(candidates: list[Candidate], primary_categories: list[Category] = ()) -> list[Candidate]:
    """Diversity bonus without replacing a strongly relevant place with a weak one."""
    pool, selected, seen = list(candidates), [], set()
    while pool and len(selected) < 3:
        requested = [c for c in pool if c.poi.category in primary_categories and c.poi.category not in seen]
        eligible = requested if selected and requested else pool
        candidate = min(
            eligible, key=lambda c: (-(c.score + (18 if c.poi.category not in seen else 0)), c.distance, c.poi.id)
        )
        pool.remove(candidate)
        selected.append(candidate)
        seen.add(candidate.poi.category)
    return selected

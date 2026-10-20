from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from app.schemas import Position, RecommendationRequest
from app.services.geo import distance_m
from app.services.hours import availability
from app.services.retrieval import retrieve


def request(**kwargs):
    return RecommendationRequest(position=Position(lat=51.1282, lon=71.4305), **kwargs)


def test_haversine_known_distance_and_symmetry():
    assert distance_m(0, 0, 0, 1) == pytest.approx(111_195, abs=10)
    assert distance_m(51, 71, 51, 71) == 0
    assert distance_m(51, 71, 52, 72) == distance_m(52, 72, 51, 71)


def test_geo_category_and_duration(populated):
    found, categories, _ = retrieve(populated, request(categories=["park"], duration_minutes=30))
    assert [c.poi.id for c in found] == ["node/1"] and categories == ["park"]
    assert all(c.total <= 30 for c in found)
    assert retrieve(populated, request(categories=["culture"], duration_minutes=30))[0] == []
    assert retrieve(populated, request(categories=["culture"], duration_minutes=120))[0]


def test_text_inference_and_explicit_filters_win(populated):
    inferred, categories, _ = retrieve(populated, request(query="Тихое кафе, чтобы поработать"))
    assert categories == ["cafe"] and inferred[0].poi.id == "node/2"
    _, categories, _ = retrieve(populated, request(query="кафе", categories=["park"]))
    assert categories == ["park"]


def test_fee_and_open_filters_do_not_treat_unknown_as_true(populated):
    found, _, _ = retrieve(populated, request(free_only=True))
    assert [c.poi.id for c in found] == ["node/1"]
    found, _, _ = retrieve(populated, request(open_now=True))
    assert {c.poi.id for c in found} == {"node/1", "node/2"}


def test_round_trip_and_mode_affect_estimate(populated):
    walking = retrieve(populated, request(categories=["cafe"]))[0][0]
    one_way = retrieve(populated, request(categories=["cafe"], round_trip=False))[0][0]
    cycling = retrieve(populated, request(categories=["cafe"], travel_mode="cycling"))[0][0]
    assert walking.total > one_way.total and cycling.travel < walking.travel


def test_no_results_outside_region(populated):
    assert retrieve(populated, RecommendationRequest(position={"lat": 0, "lon": 0}))[0] == []


def test_walk_query_prefers_outdoor_place_categories(populated):
    found, categories, _ = retrieve(populated, request(query="Хочу погулять 30–60 минут"))
    assert categories == ["park", "landmark"]
    assert all(c.poi.category in {"park", "landmark"} for c in found)


@pytest.mark.parametrize(
    ("hours", "expected"),
    [
        (None, "unknown"),
        ("24/7", "open"),
        ("Mo-Fr 09:00-18:00", "open"),
        ("Mo-Fr 18:00-22:00", "closed"),
        ("Sa-Su 09:00-18:00", "closed"),
        ("Mo-Fr 09:00-18:00; PH off", "unknown"),
        ("Mo-Su 22:00-04:00", "unknown"),
        ("Mo-Fr 09:00-18:00; Sa 99:99-24:00", "unknown"),
        ("Mo-Su 09:00-18:00; Fr off", "unknown"),
    ],
)
def test_conservative_hours(hours, expected):
    assert availability(hours, datetime(2026, 10, 16, 12, tzinfo=ZoneInfo("Asia/Almaty"))) == expected

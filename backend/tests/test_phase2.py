"""Deterministic demo regressions. Never depend on the live OSM database."""

import json
from types import SimpleNamespace

import pytest
from app.schemas import RecommendationRequest
from app.services import recommendations as service
from app.services.importer import import_payload
from app.services.intent import parse_intent, text_duration
from app.services.retrieval import retrieve
from pydantic import SecretStr, ValidationError


def request(**kwargs):
    return RecommendationRequest(position={"lat": 51.1282, "lon": 71.4305}, **kwargs)


@pytest.fixture
def demo(session):
    def node(id, name, lat, lon, **tags):
        return {"type": "node", "id": id, "lat": lat, "lon": lon, "tags": {"name": name, **tags}}

    import_payload(
        session,
        {
            "elements": [
                node(100, "Fixture Mega", 51.09, 71.4, shop="mall", **{"name:en": "Mega Silk Way"}),
                node(101, "Fixture campus park", 51.091, 71.4, leisure="park", fee="no"),
                node(102, "Fixture walk cafe", 51.091, 71.401, amenity="cafe"),
                node(103, "Fixture remote park", 51.13, 71.43, leisure="park"),
                node(104, "Fixture central cafe", 51.129, 71.431, amenity="cafe"),
                node(105, "Fixture Mosaic", 51.1283, 71.4305, tourism="artwork"),
                node(106, "Fixture city monument", 51.133, 71.432, historic="monument", wikidata="Q1"),
                node(107, "Fixture triumphal arch", 51.139, 71.434, historic="monument", tourism="attraction"),
                node(108, "Fixture indoor ride", 51.129, 71.431, tourism="attraction", indoor="area"),
                node(109, "Fixture closed cafe", 51.1283, 71.4306, amenity="cafe", opening_hours="Mo-Su off"),
                node(110, "Fixture museum", 51.129, 71.432, tourism="museum"),
            ]
        },
        "fixture://phase2-only",
    )
    return session


@pytest.mark.parametrize(
    ("query", "categories", "excluded"),
    [
        ("Хочу выпить кофе и погулять", {"cafe", "park", "landmark"}, set()),
        ("Не хочу в кафе, лучше парк", {"park"}, {"cafe"}),
        ("Не только кофе, но и парк", {"park", "cafe"}, set()),
        ("Хочу парк, но не кафе", {"park"}, {"cafe"}),
        ("Где можно спокойно провести час?", {"park", "cafe"}, set()),
        ("Хочу что-то необычное рядом", {"landmark"}, set()),
        ("Coffee and a walk", {"cafe", "park", "landmark"}, set()),
        ("No cafe, park instead", {"park"}, {"cafe"}),
        ("Кофе ішіп, серуендеу", {"cafe", "park", "landmark"}, set()),
        ("Кафеге бармаймын, саябақ керек", {"park"}, {"cafe"}),
    ],
)
def test_intent_languages_combinations_negations(query, categories, excluded):
    intent = parse_intent(request(query=query))
    assert set(intent.categories) == categories
    assert set(intent.excluded) == excluded


@pytest.mark.parametrize(
    ("query", "minutes"),
    [
        ("40 минут", 40),
        ("30–60 минут", 60),
        ("два часа", 120),
        ("полчаса", 30),
        ("час", 60),
        ("екі сағат", 120),
        ("two hours", 120),
        ("1 час 20 минут", 80),
        ("10 минут", None),
        ("500 минут", None),
        ("больше 40 минут", None),
    ],
)
def test_time_parser(query, minutes):
    assert text_duration(query) == minutes


def test_explicit_controls_win_with_notices(populated):
    req = request(query="Не хочу кафе, лучше парк, у меня 40 минут", categories=["cafe"], duration_minutes=60)
    result, categories, notices = retrieve(populated, req)
    assert categories == ["cafe"] and all(c.poi.category == "cafe" for c in result)
    assert any("категории из фильтра" in n for n in notices)
    intent = parse_intent(req)
    assert intent.duration == 60 and intent.suggested_duration == 40
    assert parse_intent(request(query="40 минут")).duration == 40


def test_a_quick_walk_and_suggestion_preserve_origin(demo, settings):
    req = RecommendationRequest(position={"lat": 51.09, "lon": 71.4}, query="Хочу погулять", duration_minutes=60)
    result = service.recommend(demo, req, settings)
    assert result.recommendations[0].poi.id == "node/101"
    assert all(r.total_minutes_estimate <= 60 for r in result.recommendations)
    original = request(query="Я возле Mega Silk Way, у меня 40 минут", duration_minutes=60)
    before = original.model_dump()
    result = service.recommend(demo, original, settings)
    assert [p.id for p in result.origin_suggestions] == ["node/100"]
    assert result.suggested_duration_minutes == 40 and result.applied_duration_minutes == 60
    assert original.model_dump() == before
    assert (
        service.recommend(demo, req.model_copy(update={"query": "Я возле Mega Silk Way"}), settings).origin_suggestions
        == []
    )


def test_b_cafe_relax_honest_unknowns(demo, settings):
    result = service.recommend(demo, request(query="Ищу тихое кафе с розетками, посидеть и отдохнуть"), settings)
    assert result.recommendations and all(r.poi.category == "cafe" for r in result.recommendations)
    assert all(r.availability == "unknown" for r in result.recommendations)
    assert all(not r.facts for r in result.recommendations)
    assert any("не подтверждены" in n for n in result.notices)
    assert all("розетки есть" not in r.explanation for r in result.recommendations)


def test_c_tourist_prefers_documented_landmarks_over_nearest_artwork(demo, settings):
    result = service.recommend(
        demo, request(query="Я турист, хочу увидеть интересные достопримечательности", duration_minutes=120), settings
    )
    assert [r.poi.id for r in result.recommendations][:2] == ["node/106", "node/107"]
    assert all(r.total_minutes_estimate <= 120 for r in result.recommendations)
    assert len({r.poi.id for r in result.recommendations}) == len(result.recommendations)
    for r in result.recommendations:
        assert "по прямой" in r.explanation and "120 мин" in r.explanation


def test_mixed_interest_selection_retains_coffee(demo, settings):
    result = service.recommend(demo, request(query="Хочу выпить кофе и погулять"), settings)
    assert {"park", "cafe"} <= {r.poi.category for r in result.recommendations}
    assert service.recommend(demo, request(query="Хочу выпить кофе и погулять"), settings) == result


def test_dense_parks_do_not_drown_out_requested_coffee(populated, settings):
    from app.models import POI

    park = populated.get(POI, "node/1")
    for i in range(20, 35):
        populated.add(
            POI(
                id=f"node/{i}",
                osm_id=i,
                osm_type="node",
                name=f"Different park {i}",
                lat=park.lat,
                lon=park.lon,
                category="park",
                tags={"leisure": "park"},
                source_url=f"https://www.openstreetmap.org/node/{i}",
                imported_at=park.imported_at,
                search_text=f"different park {i}",
            )
        )
    populated.flush()
    result = service.recommend(populated, request(query="Кофе и прогулка"), settings)
    assert {"park", "cafe"} <= {r.poi.category for r in result.recommendations}


def test_gemini_missing_requested_interest_falls_back(populated, settings, monkeypatch):
    settings.gemini_api_key = SecretStr("test-only-key")
    monkeypatch.setattr(
        service,
        "generate_plan",
        lambda *args: service.GeneratedPlan(
            recommendations=[service.GeneratedPick(poi_id="node/1", reason_codes=["nearby"], activity_code="walk")]
        ),
    )
    result = service.recommend(populated, request(query="Кофе и прогулка"), settings)
    assert result.mode == "local" and result.fallback_reason == "generation_failed"
    assert {"park", "cafe"} <= {r.poi.category for r in result.recommendations}


def test_strict_free_and_negation_filters(demo, settings):
    result = service.recommend(demo, request(query="Хочу бесплатно погулять", duration_minutes=120), settings)
    assert all(r.poi.id == "node/101" for r in result.recommendations)
    cafes = service.recommend(demo, request(query="Не хочу в кафе, лучше парк"), settings)
    assert all(r.poi.category == "park" for r in cafes.recommendations)
    assert not parse_intent(request(query="Не обязательно бесплатно, хочу кофе")).free


def test_contradictory_category_does_not_expand_to_everything(demo, settings):
    result = service.recommend(demo, request(query="Хочу кафе, но не кафе"), settings)
    assert not result.recommendations
    assert any("одновременно" in n for n in result.notices)


def test_named_interest_is_relevant_but_origin_does_not_bias_ranking(demo, settings):
    target = service.recommend(demo, request(query="Хочу посмотреть Fixture Mosaic", duration_minutes=120), settings)
    assert target.recommendations[0].poi.id == "node/105"
    plain = service.recommend(demo, request(duration_minutes=120), settings)
    near = service.recommend(demo, request(query="Я возле Fixture Mosaic", duration_minutes=120), settings)
    assert [r.poi.id for r in plain.recommendations] == [r.poi.id for r in near.recommendations]


def test_empty_hours_and_budget_are_never_relaxed(demo, settings):
    assert service.recommend(demo, request(query="кафе", open_now=True), settings).recommendations == []
    assert service.recommend(demo, request(categories=["culture"], duration_minutes=30), settings).recommendations == []
    for round_trip in (True, False):
        result = service.recommend(demo, request(query="кофе", duration_minutes=30, round_trip=round_trip), settings)
        assert all(
            r.total_minutes_estimate == r.visit_minutes_estimate + r.travel_minutes_estimate * (2 if round_trip else 1)
            for r in result.recommendations
        )
        assert all(r.total_minutes_estimate <= 30 for r in result.recommendations)


@pytest.mark.parametrize(
    "picks",
    [
        [{"poi_id": "node/1", "reason_codes": ["nearby"], "activity_code": "walk"}] * 2,
        [{"poi_id": "node/1", "reason_codes": ["nearby", "nearby"], "activity_code": "walk"}],
    ],
)
def test_grounding_rejects_duplicates(populated, picks):
    with pytest.raises(ValueError):
        service.validate_plan(service.GeneratedPlan(recommendations=picks), retrieve(populated, request())[0])


def test_extra_factual_claims_are_rejected():
    with pytest.raises(ValidationError):
        service.GeneratedPlan.model_validate(
            {
                "recommendations": [
                    {"poi_id": "node/1", "reason_codes": ["nearby"], "activity_code": "walk", "claim": "Free wifi"}
                ]
            }
        )


def test_provider_receives_only_resolved_intent_no_private_query(populated, settings, monkeypatch):
    settings.gemini_api_key = SecretStr("test-only-key")

    class Client:
        def __init__(self, **kwargs):
            self.models = self

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def generate_content(self, **kwargs):
            body = kwargs["contents"]
            assert "51.1282" not in body and "71.4305" not in body and "PRIVATE" not in body
            context = json.loads(body)
            assert context["intent"]["categories"] == ["cafe"]
            assert all(c["category"] == "cafe" for c in context["candidates"])
            return SimpleNamespace(
                text='{"recommendations":[{"poi_id":"node/2","reason_codes":["nearby"],"activity_code":"coffee"}]}'
            )

    monkeypatch.setattr(service.genai, "Client", Client)
    result = service.recommend(populated, request(query="Кофе. PRIVATE 51.1282, 71.4305"), settings)
    assert result.mode == "gemini"
    assert "по прямой" in result.recommendations[0].explanation

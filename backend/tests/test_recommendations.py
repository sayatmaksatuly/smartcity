from types import SimpleNamespace

import pytest
from app.schemas import RecommendationRequest
from app.services import recommendations as service
from google.genai import types
from pydantic import SecretStr


def request(**kwargs):
    return RecommendationRequest(position={"lat": 51.1282, "lon": 71.4305}, **kwargs)


def test_missing_key_fallback_is_grounded(populated, settings):
    result = service.recommend(populated, request(), settings)
    assert result.mode == "local" and result.fallback_reason == "missing_key"
    assert 1 <= len(result.recommendations) <= 3
    assert all(r.poi.id in {"node/1", "node/2", "node/5", "way/3"} for r in result.recommendations)
    assert "по прямой" in result.notices[-1]


@pytest.mark.parametrize("exception", [TimeoutError(), RuntimeError("429"), RuntimeError("invalid key")])
def test_generation_error_fallback(populated, settings, monkeypatch, exception):
    settings.gemini_api_key = SecretStr("test-only-key")

    def fail(*args):
        raise exception

    monkeypatch.setattr(service, "generate_plan", fail)
    result = service.recommend(populated, request(), settings)
    assert result.mode == "local" and result.fallback_reason == "generation_failed" and result.recommendations


@pytest.mark.parametrize(
    "pick",
    [
        {"poi_id": "node/999", "reason_codes": ["nearby"], "activity_code": "walk"},
        {"poi_id": "node/1", "reason_codes": ["fee_no"], "activity_code": "coffee"},
        {"poi_id": "node/2", "reason_codes": ["fee_no"], "activity_code": "coffee"},
    ],
)
def test_unknown_ids_and_unsupported_claims_rejected(populated, pick):
    candidates, _, _ = service.retrieve(populated, request())
    with pytest.raises(ValueError):
        service.validate_plan(service.GeneratedPlan(recommendations=[pick]), candidates)


def test_sdk_structured_context_and_grounded_render(populated, settings, monkeypatch):
    settings.gemini_api_key = SecretStr("test-only-key")
    calls = []

    class FakeClient:
        def __init__(self, **kwargs):
            assert isinstance(kwargs["http_options"], types.HttpOptions)
            self.models = self

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def generate_content(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                text='{"recommendations":[{"poi_id":"node/1","reason_codes":["within_time"],"activity_code":"walk"}]}'
            )

    monkeypatch.setattr(service.genai, "Client", FakeClient)
    result = service.recommend(populated, request(query="Прогулка"), settings)
    assert result.mode == "gemini" and result.recommendations[0].poi.name == "Fixture Park"
    assert '"lat"' not in calls[0]["contents"] and '"lon"' not in calls[0]["contents"]
    assert calls[0]["config"].response_schema is None
    assert calls[0]["config"].response_json_schema == service.GeneratedPlan.model_json_schema()


def test_empty_data_is_not_seeded(session, settings):
    result = service.recommend(session, request(), settings)
    assert result.recommendations == [] and result.data_status.count == 0 and "импортированы" in result.message


def test_work_cafe_does_not_invent_conditions(populated, settings):
    result = service.recommend(populated, request(query="Тихое кафе с розетками для компании из четырёх"), settings)
    assert result.recommendations[0].poi.category == "cafe"
    assert any("не подтверждены" in n for n in result.notices)

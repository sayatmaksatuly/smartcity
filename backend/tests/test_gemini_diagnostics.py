"""Generation failures must be distinguishable without leaking provider/user content."""

import json
import logging
from copy import copy
from types import SimpleNamespace

import httpx
import pytest
from app.schemas import RecommendationRequest
from app.services import recommendations as service
from google.genai import errors, types
from pydantic import SecretStr

PRIVATE = "DO-NOT-LOG-KEY private-query 51.1282 71.4305 raw-provider-response"
VALID_PICK = {"poi_id": "node/1", "reason_codes": ["nearby"], "activity_code": "walk"}


def request():
    return RecommendationRequest(position={"lat": 51.1282, "lon": 71.4305}, query=PRIVATE)


def fake_client(monkeypatch, *, response=None, error=None):
    class Client:
        def __init__(self, **kwargs):
            self.models = self

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def generate_content(self, **kwargs):
            if error is not None:
                raise error
            return response

    monkeypatch.setattr(service.genai, "Client", Client)


def assert_safe_fallback(populated, settings, caplog, *, stage, code, http_status="none"):
    settings.gemini_api_key = SecretStr(PRIVATE)
    with caplog.at_level(logging.WARNING, logger=service.__name__):
        result = service.recommend(populated, request(), settings)
    assert result.mode == "local" and result.fallback_reason == "generation_failed"
    assert result.recommendations
    records = [r for r in caplog.records if r.name == service.__name__]
    assert len(records) == 1
    assert records[0].getMessage() == (
        f"recommendation_generation_failed stage={stage} code={code} http_status={http_status}"
    )
    assert records[0].exc_info is None and records[0].stack_info is None
    for secret in PRIVATE.split():
        assert secret not in caplog.text
    assert PRIVATE not in result.model_dump_json()
    return result


@pytest.mark.parametrize(
    ("error", "code", "status"),
    [
        (
            errors.ClientError(
                400,
                {
                    "error": {
                        "message": 'Unknown name "additional_properties" at generation_config.response_schema '
                        + PRIVATE
                    }
                },
            ),
            "unsupported_schema_field",
            400,
        ),
        (errors.ClientError(429, {"error": {"message": PRIVATE}}), "provider_http_error", 429),
        (httpx.ReadTimeout(PRIVATE), "timeout", "none"),
        (TimeoutError(PRIVATE), "timeout", "none"),
        (RuntimeError(PRIVATE), "sdk_error", "none"),
    ],
)
def test_safe_call_diagnostics(populated, settings, monkeypatch, caplog, error, code, status):
    fake_client(monkeypatch, error=error)
    assert_safe_fallback(populated, settings, caplog, stage="call", code=code, http_status=status)


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("", "empty_response"),
        ("  ", "empty_response"),
        (PRIVATE, "invalid_json"),
        (json.dumps({"recommendations": [VALID_PICK], "invented_fact": PRIVATE}), "schema_invalid"),
        (json.dumps({"recommendations": []}), "schema_invalid"),
        (json.dumps({"recommendations": [VALID_PICK | {"reason_codes": [PRIVATE]}]}), "schema_invalid"),
    ],
)
def test_safe_parse_diagnostics(populated, settings, monkeypatch, caplog, text, code):
    fake_client(monkeypatch, response=SimpleNamespace(text=text))
    assert_safe_fallback(populated, settings, caplog, stage="parse", code=code)


def test_unexpected_response_accessor_error_has_safe_parse_diagnostic(populated, settings, monkeypatch, caplog):
    class BrokenResponse:
        @property
        def text(self):
            raise RuntimeError(PRIVATE)

    fake_client(monkeypatch, response=BrokenResponse())
    assert_safe_fallback(populated, settings, caplog, stage="parse", code="response_parse_error")


@pytest.mark.parametrize(("finish", "code"), [("MAX_TOKENS", "truncated_response"), ("SAFETY", "non_success_finish")])
def test_incomplete_response_rejected_even_with_valid_json(populated, settings, monkeypatch, caplog, finish, code):
    response = types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                finish_reason=finish,
                content=types.Content(parts=[types.Part(text=json.dumps({"recommendations": [VALID_PICK]}))]),
            )
        ]
    )
    fake_client(monkeypatch, response=response)
    assert_safe_fallback(populated, settings, caplog, stage="parse", code=code)


def test_blocked_response_is_classified(populated, settings, monkeypatch, caplog):
    response = types.GenerateContentResponse(
        prompt_feedback=types.GenerateContentResponsePromptFeedback(block_reason="SAFETY")
    )
    fake_client(monkeypatch, response=response)
    assert_safe_fallback(populated, settings, caplog, stage="parse", code="blocked_response")


@pytest.mark.parametrize(
    ("picks", "code"),
    [
        ([VALID_PICK | {"poi_id": PRIVATE}], "unknown_poi"),
        ([VALID_PICK, VALID_PICK], "duplicate_poi"),
        ([VALID_PICK | {"reason_codes": ["fee_no"]}], "unsupported_reason"),
        ([VALID_PICK | {"reason_codes": ["nearby", "nearby"]}], "duplicate_reason"),
        ([VALID_PICK | {"activity_code": "coffee"}], "invalid_activity"),
    ],
)
def test_safe_grounding_diagnostics(populated, settings, monkeypatch, caplog, picks, code):
    fake_client(monkeypatch, response=SimpleNamespace(text=json.dumps({"recommendations": picks})))
    assert_safe_fallback(populated, settings, caplog, stage="grounding", code=code)


def test_same_place_different_ids_remains_rejected(populated):
    candidates, _, _ = service.retrieve(populated, request())
    original = next(c for c in candidates if c.poi.id == "node/1")
    duplicate = copy(original)
    # Plain object with the same mapped identity/position avoids mutating SQLAlchemy state.
    duplicate.poi = SimpleNamespace(
        id="way/99",
        name=original.poi.name,
        tags=original.poi.tags,
        category=original.poi.category,
        lat=original.poi.lat,
        lon=original.poi.lon,
    )
    plan = service.GeneratedPlan(recommendations=[VALID_PICK, VALID_PICK | {"poi_id": "way/99"}])
    with pytest.raises(service.GroundingError) as error:
        service.validate_plan(plan, [original, duplicate])
    assert error.value.code == "duplicate_place"


def test_missing_interest_has_grounding_code(populated):
    req = RecommendationRequest(position=request().position, query="Кофе и прогулка")
    candidates, _, _ = service.retrieve(populated, req)
    plan = service.GeneratedPlan(recommendations=[VALID_PICK])
    with pytest.raises(service.GroundingError) as error:
        service.validate_plan(plan, candidates, ["park", "cafe"])
    assert error.value.code == "missing_interest"


def test_success_emits_no_failure_diagnostic(populated, settings, monkeypatch, caplog):
    settings.gemini_api_key = SecretStr(PRIVATE)
    fake_client(monkeypatch, response=SimpleNamespace(text=json.dumps({"recommendations": [VALID_PICK]})))
    result = service.recommend(populated, request(), settings)
    assert result.mode == "gemini" and result.fallback_reason is None
    assert not [r for r in caplog.records if r.name == service.__name__]

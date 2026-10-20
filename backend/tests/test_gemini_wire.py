"""Exercise real SDK serialization offline, below the generate_content mock boundary."""

import json
from types import SimpleNamespace

import httpx
import pytest
from app.schemas import RecommendationRequest
from app.services import recommendations as service
from pydantic import SecretStr


def valid_plan():
    return {"recommendations": [{"poi_id": "node/1", "reason_codes": ["within_time"], "activity_code": "walk"}]}


@pytest.fixture
def google_wire(monkeypatch, settings):
    """Keep Google's actual serializer and parser; replace only the HTTP transport."""
    state = SimpleNamespace(requests=[], response=valid_plan())
    real_client = service.genai.Client
    settings.gemini_api_key = SecretStr("test-only-key")

    def transport(request):
        state.requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {
                        "content": {"role": "model", "parts": [{"text": json.dumps(state.response)}]},
                        "finishReason": "STOP",
                    }
                ]
            },
        )

    with httpx.Client(transport=httpx.MockTransport(transport), trust_env=False) as http_client:

        def client_factory(**kwargs):
            kwargs["http_options"] = kwargs["http_options"].model_copy(update={"httpx_client": http_client})
            return real_client(**kwargs)

        monkeypatch.setattr(service.genai, "Client", client_factory)
        yield state


def test_real_sdk_serializes_strict_json_schema(populated, settings, google_wire):
    request = RecommendationRequest(position={"lat": 51.1282, "lon": 71.4305}, query="Прогулка")
    candidates, _, _ = service.retrieve(populated, request)
    plan = service.generate_plan(candidates, request, settings)

    assert isinstance(plan, service.GeneratedPlan)
    assert plan.model_dump() == valid_plan()
    assert len(google_wire.requests) == 1
    config = google_wire.requests[0]["generationConfig"]
    assert config["responseMimeType"] == "application/json"
    assert "responseSchema" not in config
    schema = config["responseJsonSchema"]
    assert schema == service.GeneratedPlan.model_json_schema()
    assert schema["additionalProperties"] is False
    assert schema["$defs"]["GeneratedPick"]["additionalProperties"] is False
    assert schema["properties"]["recommendations"]["minItems"] == 1
    assert schema["properties"]["recommendations"]["maxItems"] == 3
    assert "additional_properties" not in json.dumps(schema)
    assert service.validate_plan(plan, candidates)[0][0].poi.id == "node/1"


@pytest.mark.parametrize("location", ["root", "pick"])
def test_real_sdk_response_still_rejects_extra_claims(populated, settings, google_wire, location):
    if location == "root":
        google_wire.response["claim"] = "Invented property"
    else:
        google_wire.response["recommendations"][0]["claim"] = "Invented property"
    request = RecommendationRequest(position={"lat": 51.1282, "lon": 71.4305}, query="Прогулка")
    candidates, _, _ = service.retrieve(populated, request)

    with pytest.raises(service.StructuredOutputError) as error:
        service.generate_plan(candidates, request, settings)
    assert error.value.stage == "parse"
    assert len(google_wire.requests) == 1

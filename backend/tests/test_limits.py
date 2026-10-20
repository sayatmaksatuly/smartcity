import pytest
from app.main import generation_gate
from app.services.limits import RequestGate, RequestLimitError


def test_chat_and_recommendations_share_generation_quota(client, populated, settings):
    settings.generation_requests_per_minute = 1
    response = client.post("/api/chat", json={"message": "Хочу погулять"})
    assert response.status_code == 200
    response = client.post("/api/recommendations", json={"position": {"lat": 51.1282, "lon": 71.4305}})
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/pois").status_code == 200


def test_generation_concurrency_is_bounded(client, populated):
    with generation_gate.acquire(30), generation_gate.acquire(30):
        response = client.post("/api/chat", json={"message": "Хочу погулять"})
    assert response.status_code == 503
    assert client.post("/api/chat", json={"message": "Хочу погулять"}).status_code == 200


def test_request_gate_resets_after_failures():
    gate = RequestGate(max_active=1)
    with pytest.raises(ValueError), gate.acquire(10):
        raise ValueError("fixture")
    with gate.acquire(10):
        with pytest.raises(RequestLimitError, match="busy"), gate.acquire(10):
            pass
    gate.reset()
    assert not gate._starts and gate._active == 0

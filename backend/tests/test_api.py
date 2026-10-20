import pytest


def test_health_and_empty_status(client):
    assert client.get("/api/health").json()["status"] == "ok"
    assert client.get("/api/data-status").json()["count"] == 0


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"position": {"lat": 91, "lon": 71}},
        {"position": {"lat": 51, "lon": 181}},
        {"position": {"lat": 51, "lon": 71}, "duration_minutes": 0},
        {"position": {"lat": 51, "lon": 71}, "categories": ["imaginary"]},
        {"position": {"lat": 51, "lon": 71}, "query": "x" * 601},
    ],
)
def test_input_validation(client, body):
    response = client.post("/api/recommendations", json=body)
    assert response.status_code == 422 and "detail" in response.json()


def test_pagination_and_query(client, populated):
    response = client.get("/api/pois?limit=2")
    assert response.status_code == 200
    assert len(response.json()["items"]) == 2 and response.json()["total"] == 5
    assert client.get("/api/pois?limit=101").status_code == 422
    assert client.get("/api/pois?south=52&north=51").status_code == 422
    assert client.get("/api/pois?q=музей").json()["total"] == 1
    assert client.get("/api/pois?q=%25").json()["total"] == 0


def test_recommendation_endpoint(client, populated):
    response = client.post(
        "/api/recommendations",
        json={"position": {"lat": 51.1282, "lon": 71.4305}, "query": "кафе", "duration_minutes": 60},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["mode"] == "local" and data["recommendations"][0]["poi"]["id"] == "node/2"


def test_no_http_import_endpoint(client):
    assert client.post("/api/import").status_code == 404

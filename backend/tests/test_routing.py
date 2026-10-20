import json

import httpx
import pytest
from app.schemas import RouteRequest
from app.services import routing
from app.services.importer import import_payload

ORIGIN = {"lat": 51.1282, "lon": 71.4305}


def provider_response(coordinates, *, distance=700, duration=602):
    # A curved synthetic test road, distinct from joining POIs in production.
    geometry = [coordinates[0], [71.431, 51.12825], *coordinates[1:]]
    return {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": geometry},
            "properties": {
                "summary": {"distance": distance, "duration": duration},
                "way_points": [0, *range(2, len(geometry))],
            },
        }],
        "metadata": {"query": {"secret": "must-not-be-forwarded"}},
    }


@pytest.fixture
def ors(client, populated, monkeypatch, settings):
    # Use a real SecretStr as configuration does, without reading any .env.
    from pydantic import SecretStr

    settings.ors_api_key = SecretStr("test-routing-credential")
    monkeypatch.setattr(routing, "route_gate", routing.RouteGate())
    sent = []
    overrides = {"handler": None}

    def handle(request):
        sent.append(request)
        if overrides["handler"]:
            return overrides["handler"](request)
        return httpx.Response(200, json=provider_response(json.loads(request.content)["coordinates"]))

    real_client = httpx.Client

    def fake_client(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["timeout"].connect <= 5
        return real_client(transport=httpx.MockTransport(handle), **kwargs)

    monkeypatch.setattr(routing.httpx, "Client", fake_client)
    return sent, overrides


def route(client, ids=None, **kwargs):
    return client.post("/api/routes", json={"origin": ORIGIN, "poi_ids": ids or ["node/1"], **kwargs})


def test_route_uses_sqlite_destinations_and_geojson_order(client, ors):
    response = route(client, ["way/3", "node/2"], duration_minutes=120)
    assert response.status_code == 200
    body = response.json()
    assert body["poi_ids"] == ["way/3", "node/2"]
    assert body["geometry"]["type"] == "LineString"
    assert body["geometry"]["coordinates"][0] == [71.4305, 51.1282]
    assert body["geometry"]["coordinates"][1] == [71.431, 51.12825]
    assert body["distance_m"] == 700 and body["duration_seconds"] == 602
    assert body["visit_minutes"] == 70 and body["total_minutes"] == 81
    assert body["feasible"] is True
    assert body["provider"] == "openrouteservice" and body["profile"] == "foot-walking"
    assert "OpenStreetMap" in body["attribution"]
    assert "metadata" not in body and "must-not-be-forwarded" not in response.text
    sent, _ = ors
    request = sent[0]
    assert str(request.url) == routing.ORS_URL and "test-routing-credential" not in str(request.url)
    assert request.headers["Authorization"] == "test-routing-credential"
    assert json.loads(request.content) == {
        "coordinates": [[71.4305, 51.1282], [71.432, 51.129], [71.432, 51.13]],
        "instructions": False,
        "elevation": False,
        "radiuses": [250, 250, 250],
    }


def test_round_trip_is_provider_route_and_budget_is_honest(client, ors):
    response = route(client, ["node/1", "node/2", "way/3"], round_trip=True, duration_minutes=60)
    assert response.status_code == 200
    assert response.json()["feasible"] is False
    assert response.json()["round_trip"] is True
    sent, _ = ors
    coordinates = json.loads(sent[0].content)["coordinates"]
    assert len(coordinates) == 5 and coordinates[0] == coordinates[-1]
    assert response.json()["geometry"]["coordinates"][-1] == coordinates[0]


def test_route_without_budget_does_not_claim_feasibility(client, ors):
    assert route(client).json()["feasible"] is None


def test_missing_configuration_never_creates_geometry(client, populated, settings):
    from pydantic import SecretStr

    settings.ors_api_key = SecretStr("")
    response = route(client)
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "routing_not_configured"
    assert "geometry" not in response.json()


@pytest.mark.parametrize("ids", [[], ["fake/12"], ["node/1", "node/1"], ["node/1"] * 4])
def test_invalid_ids_do_not_call_provider(client, ors, ids):
    response = client.post("/api/routes", json={"origin": ORIGIN, "poi_ids": ids})
    assert response.status_code == 422
    assert not ors[0]


@pytest.mark.parametrize("origin", [{"lat": 91, "lon": 71}, {"lat": 51, "lon": 181},
                                           {"lat": 0, "lon": 0}, {"lat": "NaN", "lon": 71}])
def test_invalid_or_outside_origin_does_not_call_provider(client, ors, origin):
    response = client.post("/api/routes", json={"origin": origin, "poi_ids": ["node/1"]})
    assert response.status_code == 422
    assert not ors[0]


def test_client_cannot_override_sqlite_destination_or_provider(client, ors):
    response = route(client, destination={"lat": 51.12, "lon": 71.42}, provider_url="https://example.test")
    assert response.status_code == 422 and not ors[0]


def test_unknown_poi_does_not_call_provider(client, ors):
    response = route(client, ["node/99999"])
    assert response.status_code == 404 and response.json()["detail"]["code"] == "poi_not_found"
    assert not ors[0]


@pytest.mark.parametrize("status,provider_code,expected_status,expected_code", [
    (403, None, 503, "routing_unavailable"),
    (429, None, 429, "routing_rate_limited"),
    (500, None, 503, "routing_unavailable"),
    (404, 2010, 422, "route_not_found"),
    (400, 2009, 422, "route_not_found"),
    (400, 2004, 503, "routing_unavailable"),
    (302, None, 503, "routing_unavailable"),
])
def test_provider_errors_are_safe_without_retries(client, ors, caplog, status, provider_code,
                                                  expected_status, expected_code):
    ors[1]["handler"] = lambda _: httpx.Response(status, json={"error": {
        "code": provider_code, "message": "test-routing-credential private-coordinates",
    }}, headers={"Location": "https://example.test/credential-sink"})
    response = route(client)
    assert response.status_code == expected_status
    assert response.json()["detail"]["code"] == expected_code
    assert "test-routing-credential" not in response.text + caplog.text
    assert "private-coordinates" not in response.text + caplog.text
    assert len(ors[0]) == 1
    if status == 429:
        assert response.headers["Retry-After"] == "60"


@pytest.mark.parametrize("exception,expected", [
    (httpx.ReadTimeout, "routing_timeout"), (httpx.ConnectError, "routing_unavailable"),
])
def test_transport_failures_are_safe(client, ors, caplog, exception, expected):
    def fail(_):
        raise exception("test-routing-credential private-coordinates")

    ors[1]["handler"] = fail
    response = route(client)
    assert response.json()["detail"]["code"] == expected
    assert "test-routing-credential" not in response.text + caplog.text
    assert len(ors[0]) == 1


@pytest.mark.parametrize("mutation", [
    lambda p: p.update(type="Feature"),
    lambda p: p.update(features=[]),
    lambda p: p["features"][0]["geometry"].update(type="Polygon"),
    lambda p: p["features"][0]["geometry"].update(coordinates=[[71, 51]]),
    lambda p: p["features"][0]["geometry"].update(coordinates=[[181, 51], [71, 51]]),
    lambda p: p["features"][0]["geometry"].update(coordinates=[[51.1282, 71.4305], [51.1283, 71.4306]]),
    lambda p: p["features"][0]["properties"]["summary"].update(distance=-1),
    lambda p: p["features"][0]["properties"]["summary"].update(duration="602"),
    lambda p: p["features"][0]["properties"].update(way_points=[0, 500]),
    lambda p: p["features"][0]["properties"].update(way_points=[0]),
])
def test_malformed_routes_never_return_geometry(client, ors, mutation):
    def malformed(request):
        payload = provider_response(json.loads(request.content)["coordinates"])
        mutation(payload)
        return httpx.Response(200, json=payload)

    ors[1]["handler"] = malformed
    response = route(client)
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "routing_invalid_response"
    assert "geometry" not in response.json()


@pytest.mark.parametrize("body", [b"not json", b"[]", b"x" * (routing.MAX_RESPONSE_BYTES + 1)],
                         ids=["not-json", "array", "too-large"])
def test_non_json_and_large_response_is_bounded(client, ors, body):
    ors[1]["handler"] = lambda _: httpx.Response(200, content=body)
    assert route(client).json()["detail"]["code"] == "routing_invalid_response"


def test_global_quota_prevents_extra_provider_calls(client, ors, settings):
    settings.ors_requests_per_minute = 1
    assert route(client).status_code == 200
    response = route(client)
    assert response.status_code == 429
    assert response.json()["detail"]["code"] == "routing_rate_limited"
    assert len(ors[0]) == 1


def test_gate_limits_concurrency_and_releases_after_failure():
    gate = routing.RouteGate()
    with gate.acquire(20), gate.acquire(20):
        with pytest.raises(routing.RouteError, match="routing_busy"), gate.acquire(20):
            pass
    with pytest.raises(RuntimeError), gate.acquire(20):
        raise RuntimeError("fixture")
    with gate.acquire(20):
        assert gate._active == 1
    assert gate._active == 0


def test_gate_quota_expires_without_storing_personal_data(monkeypatch):
    clock = [0]
    monkeypatch.setattr(routing.time, "monotonic", lambda: clock[0])
    gate = routing.RouteGate()
    with gate.acquire(1):
        pass
    clock[0] = 61
    with gate.acquire(1):
        assert len(gate._starts) == 1


def test_resolve_is_ordered_grounded_and_safe_for_deleted_pois(client, populated, payload):
    ids = ["way/3", "node/1", "node/999", "way/3"]
    response = client.post("/api/pois/resolve", json={"poi_ids": ids})
    assert [p["id"] for p in response.json()["items"]] == ["way/3", "node/1"]
    assert response.json()["missing_ids"] == ["node/999"]
    payload["elements"][0]["tags"]["name"] = "Updated Fixture Park"
    import_payload(populated, payload, "fixture://stable-ids-reimport")
    resolved = client.post("/api/pois/resolve", json={"poi_ids": ["node/1"]}).json()
    assert resolved["items"][0]["id"] == "node/1"
    assert resolved["items"][0]["name"] == "Updated Fixture Park"
    payload["elements"] = payload["elements"][1:]
    import_payload(populated, payload, "fixture://removed-poi")
    removed = client.post("/api/pois/resolve", json={"poi_ids": ["node/1"]}).json()
    assert removed == {"items": [], "missing_ids": ["node/1"]}


def test_resolve_request_is_bounded(client, populated):
    assert client.post("/api/pois/resolve", json={"poi_ids": []}).json() == {"items": [], "missing_ids": []}
    assert client.post("/api/pois/resolve", json={"poi_ids": ["node/1"] * 101}).status_code == 422
    assert client.post("/api/pois/resolve", json={"poi_ids": ["../secret"]}).status_code == 422


def test_settings_mask_routing_secret(settings):
    from pydantic import SecretStr

    settings.ors_api_key = SecretStr("do-not-display")
    assert "do-not-display" not in repr(settings)


def test_distance_bound_prevents_quota_use(populated, settings, monkeypatch):
    from app.models import POI

    populated.get(POI, "node/1").lat = 51.25
    populated.get(POI, "node/1").lon = 71.65
    populated.get(POI, "node/2").lat = 51.00
    populated.get(POI, "node/2").lon = 71.25
    request = RouteRequest(origin={"lat": 51.00, "lon": 71.25}, poi_ids=["node/1", "node/2"])
    with pytest.raises(routing.RouteError, match="route_too_long"):
        routing.build_route(populated, request, settings)

from datetime import datetime, timezone

import httpx
import pytest
from app.models import POI, ImportRun
from app.services.importer import build_query, deduplicate, fetch_overpass, import_payload, normalize
from sqlalchemy import func, select

NOW = datetime(2026, 10, 16, tzinfo=timezone.utc)


def test_normalization_names_source_center(payload):
    row = normalize(payload["elements"][2], NOW)
    assert row["name"] == "Тестовый музей"
    assert row["source_url"] == "https://www.openstreetmap.org/way/3"
    assert row["lat"] == 51.129
    assert row["opening_hours"] is None and row["address"] is None


@pytest.mark.parametrize("patch", [{"lat": float("nan")}, {"lat": 91}, {"lon": 0}, {"type": "invalid"}, {"id": -1}])
def test_bad_elements_rejected(payload, patch):
    assert normalize(payload["elements"][0] | patch, NOW) is None


def test_private_and_missing_name_rejected(payload):
    element = payload["elements"][0]
    element["tags"]["access"] = "private"
    assert normalize(element, NOW) is None
    element["tags"] = {"leisure": "park"}
    assert normalize(element, NOW) is None


def test_dedup_stable_and_keeps_distant_branches(payload):
    row = normalize(payload["elements"][0], NOW)
    duplicate = row | {"id": "way/22", "osm_id": 22}
    branch = row | {"id": "node/23", "osm_id": 23, "lat": 51.2}
    result = deduplicate([duplicate, row, branch])
    assert [r["id"] for r in result] == ["node/1", "node/23"]
    assert deduplicate([branch, row, duplicate]) == result


def test_import_idempotent_updates_and_records_provenance(session, payload, tmp_path):
    first = import_payload(session, payload, "fixture://test", tmp_path / "raw.json")
    digest = first.payload_sha256
    import_payload(session, payload, "fixture://test")
    assert session.scalar(select(func.count()).select_from(POI)) == 5
    assert session.scalar(select(func.count()).select_from(ImportRun)) == 2
    assert (tmp_path / "raw.json").exists() and len(digest) == 64
    payload["elements"][0]["tags"]["name"] = "Updated Fixture Park"
    import_payload(session, payload, "fixture://test")
    assert session.get(POI, "node/1").name == "Updated Fixture Park"


def test_dedup_uses_multilingual_aliases(payload):
    row = normalize(payload["elements"][0], NOW)
    russian = row | {
        "id": "way/22",
        "name": "Тестовый парк",
        "tags": row["tags"] | {"name": "Тестовый парк", "name:en": "Fixture Park"},
    }
    assert len(deduplicate([row, russian])) == 1


def test_dedup_normalizes_spacing_and_appended_city(payload):
    row = normalize(payload["elements"][0], NOW)
    spaced = row | {"id": "way/22", "name": "FixturePark Astana"}
    assert len(deduplicate([row, spaced])) == 1


@pytest.mark.parametrize("bad", [{"remark": "timeout", "elements": []}, {"elements": []}, {}])
def test_failure_preserves_previous_data(populated, bad):
    with pytest.raises(ValueError):
        import_payload(populated, bad, "fixture://bad")
    assert populated.scalar(select(func.count()).select_from(POI)) == 5
    assert populated.scalar(select(func.count()).select_from(ImportRun)) == 1


def test_successful_snapshot_removes_stale(populated, payload):
    payload["elements"] = payload["elements"][:2]
    import_payload(populated, payload, "fixture://test")
    assert populated.scalar(select(func.count()).select_from(POI)) == 2


def test_retry_backoff_and_fallback_endpoint(payload):
    requests, sleeps = [], []

    def handle(request):
        requests.append(request)
        return httpx.Response(429) if len(requests) < 3 else httpx.Response(200, json=payload)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result, endpoint = fetch_overpass(["https://first.test/api", "https://second.test/api"], client, sleeps.append)
    assert result == payload and endpoint == "https://second.test/api"
    assert sleeps == [10, 5] and len(requests) == 3


def test_network_failure_is_bounded():
    def handle(request):
        raise httpx.ConnectError("unavailable", request=request)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client, pytest.raises(RuntimeError):
        fetch_overpass(["https://fixture.test"], client, lambda _: None)


def test_query_is_bounded_and_selects_named_pois():
    query = build_query()
    assert "[timeout:60]" in query and "51.0,71.25,51.25,71.65" in query
    assert "out center tags" in query and "name" in query

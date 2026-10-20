from copy import deepcopy

import pytest
from app.core.config import Settings
from app.db import Base, get_session, make_engine
from app.main import app
from app.services.importer import import_payload
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session


@pytest.fixture
def payload():
    # Synthetic isolated fixtures; never used by the production importer.
    return deepcopy(
        {
            "osm3s": {"timestamp_osm_base": "2026-10-16T10:00:00Z"},
            "elements": [
                {
                    "type": "node",
                    "id": 1,
                    "lat": 51.1283,
                    "lon": 71.4306,
                    "tags": {"name": "Fixture Park", "leisure": "park", "fee": "no", "opening_hours": "24/7"},
                },
                {
                    "type": "node",
                    "id": 2,
                    "lat": 51.1300,
                    "lon": 71.4320,
                    "tags": {
                        "name": "Fixture Cafe",
                        "amenity": "cafe",
                        "opening_hours": "24/7",
                        "internet_access": "wlan",
                    },
                },
                {
                    "type": "way",
                    "id": 3,
                    "center": {"lat": 51.129, "lon": 71.432},
                    "tags": {"name": "Fixture Museum", "tourism": "museum", "name:ru": "Тестовый музей"},
                },
                {
                    "type": "node",
                    "id": 4,
                    "lat": 51.2,
                    "lon": 71.5,
                    "tags": {"name": "Distant Park", "leisure": "park"},
                },
                {
                    "type": "node",
                    "id": 5,
                    "lat": 51.1284,
                    "lon": 71.4307,
                    "tags": {"name": "Fixture Landmark", "historic": "monument"},
                },
            ],
        }
    )


@pytest.fixture
def session(tmp_path):
    engine = make_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}")
    Base.metadata.create_all(engine)
    with Session(engine, expire_on_commit=False) as session:
        yield session
    engine.dispose()


@pytest.fixture
def populated(session, payload):
    import_payload(session, payload, "fixture://test-only")
    return session


@pytest.fixture
def settings():
    return Settings(_env_file=None, gemini_api_key="")


@pytest.fixture
def client(session, monkeypatch, settings):
    monkeypatch.setattr("app.main.get_settings", lambda: settings)
    monkeypatch.setattr("app.main.init_db", lambda: None)
    app.dependency_overrides[get_session] = lambda: session
    with TestClient(app, raise_server_exceptions=True) as client:
        yield client
    app.dependency_overrides.clear()

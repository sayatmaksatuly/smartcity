"""Explicit test-only server with a disposable database; never opens the real POI DB."""

import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with TemporaryDirectory(prefix="aitu-e2e-") as directory:
        os.environ["DATABASE_URL"] = f"sqlite:///{Path(directory).as_posix()}/fixture.db"
        os.environ["GEMINI_API_KEY"] = ""
        os.environ["ORS_API_KEY"] = ""
        os.environ["GENERATION_REQUESTS_PER_MINUTE"] = "120"
        import uvicorn
        from app.db import SessionLocal, engine, init_db
        from app.services.importer import import_payload

        init_db()

        def node(id, name, lat, lon, **tags):
            return {"type": "node", "id": id, "lat": lat, "lon": lon, "tags": {"name": name, **tags}}

        with SessionLocal() as session:
            import_payload(
                session,
                {
                    "elements": [
                        node(1, "Fixture Park", 51.1283, 71.4306, leisure="park", fee="no", opening_hours="24/7"),
                        node(2, "Fixture Cafe", 51.13, 71.432, amenity="cafe"),
                        node(3, "Fixture Museum", 51.129, 71.432, tourism="museum"),
                        node(5, "Fixture Landmark", 51.1284, 71.4307, historic="monument"),
                        node(100, "Mega Silk Way", 51.09, 71.4, shop="mall"),
                        node(101, "Fixture Mega Park", 51.091, 71.401, leisure="park", fee="no"),
                    ]
                },
                "fixture://e2e-only",
            )
        try:
            uvicorn.run("app.main:app", host="127.0.0.1", port=8001, access_log=False, log_level="warning")
        finally:
            engine.dispose()


if __name__ == "__main__":
    main()

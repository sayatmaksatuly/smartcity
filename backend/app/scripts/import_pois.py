import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.core.config import DATA_DIR, get_settings
from app.db import SessionLocal, init_db
from app.services.importer import fetch_overpass, import_payload


def main():
    parser = argparse.ArgumentParser(description="Collect real Astana POIs from Overpass")
    parser.add_argument(
        "--from-snapshot",
        type=Path,
        help="Explicitly replay a previously collected Overpass JSON snapshot (never test fixtures)",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    init_db()
    try:
        if args.from_snapshot:
            logging.info("Replaying an existing collection snapshot; no network fetch")
            payload = json.loads(args.from_snapshot.read_text(encoding="utf-8"))
            endpoint = f"snapshot:{args.from_snapshot.name}"
            snapshot = None
        else:
            payload, endpoint = fetch_overpass(get_settings().overpass_endpoints)
            snapshot = DATA_DIR / "imports" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + ".json")
        with SessionLocal() as session:
            result = import_payload(session, payload, endpoint, snapshot)
            logging.info(
                "Imported %d POIs from %d elements. SHA256=%s",
                result.poi_count,
                result.raw_count,
                result.payload_sha256,
            )
            logging.info("Raw collection evidence: %s", snapshot or args.from_snapshot)
    except (RuntimeError, ValueError, OSError) as exc:
        logging.error("%s", exc)
        sys.exit(1)


if __name__ == "__main__":
    main()

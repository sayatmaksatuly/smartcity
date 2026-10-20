"""Read-only audit of the existing OSM database. No fetches or synthetic POIs."""

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.core.config import ASTANA_BBOX  # noqa: E402
from app.db import SessionLocal  # noqa: E402
from app.models import POI, ImportRun  # noqa: E402
from app.services.hours import availability  # noqa: E402
from app.services.importer import category_for, deduplicate  # noqa: E402
from sqlalchemy import select  # noqa: E402


def main():
    with SessionLocal() as session:
        pois = list(session.scalars(select(POI)))
        latest = session.scalar(select(ImportRun).order_by(ImportRun.id.desc()).limit(1))
        rows = [dict(id=p.id, name=p.name, category=p.category, tags=p.tags, lat=p.lat, lon=p.lon) for p in pois]
        south, west, north, east = ASTANA_BBOX
        report = {
            "count": len(pois),
            "categories": dict(sorted(Counter(p.category for p in pois).items())),
            "duplicates_by_import_rule": len(pois) - len(deduplicate(rows)),
            "category_mismatches": sum(p.category != category_for(p.tags) for p in pois),
            "invalid_source_links": sum(p.source_url != f"https://www.openstreetmap.org/{p.id}" for p in pois),
            "outside_bbox": sum(not (south <= p.lat <= north and west <= p.lon <= east) for p in pois),
            "missing_hours": sum(not p.opening_hours for p in pois),
            "unsupported_hours": sum(
                bool(p.opening_hours) and availability(p.opening_hours) == "unknown" for p in pois
            ),
            "explicit_fee_no": sum(p.tags.get("fee") == "no" for p in pois),
            "latest_import_raw_count": latest.raw_count if latest else None,
            "latest_import_poi_count": latest.poi_count if latest else None,
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        assert not any(
            report[key]
            for key in ("duplicates_by_import_rule", "category_mismatches", "invalid_source_links", "outside_bbox")
        )


if __name__ == "__main__":
    main()

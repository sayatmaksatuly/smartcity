"""Bounded, atomic, reproducible OSM ingestion. Never inserts demonstration data."""

import hashlib
import json
import logging
import math
import re
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

import httpx
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import ASTANA_BBOX
from app.models import POI, ImportRun
from app.services.geo import distance_m

logger = logging.getLogger(__name__)


def fold(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold().replace("ё", "е").strip()


def name_key(value: str) -> str:
    # Common bilingual aliases may differ in spacing and an appended city label.
    normalized = re.sub(r"[\s,]+(?:astana|астана)$", "", fold(value))
    return "".join(char for char in normalized if char.isalnum())


def category_for(tags: dict) -> str | None:
    if tags.get("amenity") == "cafe":
        return "cafe"
    if tags.get("tourism") in {"museum", "gallery"} or tags.get("amenity") in {"theatre", "arts_centre"}:
        return "culture"
    if tags.get("leisure") in {"park", "garden", "nature_reserve"} or tags.get("place") == "square":
        return "park"
    if tags.get("tourism") in {"attraction", "viewpoint", "artwork"} or tags.get("historic") in {
        "monument",
        "memorial",
    }:
        return "landmark"
    if tags.get("leisure") in {"sports_centre", "ice_rink", "playground"}:
        return "recreation"
    if tags.get("amenity") == "library" or tags.get("shop") == "mall":
        return "venue"
    return None


def normalize(element: dict, imported_at: datetime, bbox=ASTANA_BBOX) -> dict | None:
    tags = element.get("tags", {})
    if not isinstance(tags, dict):
        return None
    tags = {str(k)[:100]: str(v)[:2000] for k, v in tags.items() if isinstance(v, (str, int, float))}
    name = tags.get("name:ru") or tags.get("name") or tags.get("name:kk") or tags.get("name:en")
    category = category_for(tags)
    if not name or not name.strip() or not category or tags.get("access") in {"private", "no"}:
        return None
    if any(tags.get(k) in {"yes", "true", "1"} for k in ("disused", "abandoned", "demolished")):
        return None
    osm_type, osm_id = element.get("type"), element.get("id")
    if osm_type not in {"node", "way", "relation"} or not isinstance(osm_id, int) or osm_id <= 0:
        return None
    center = element if osm_type == "node" else element.get("center", {})
    try:
        lat, lon = float(center["lat"]), float(center["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    south, west, north, east = bbox
    if not (math.isfinite(lat) and math.isfinite(lon) and south <= lat <= north and west <= lon <= east):
        return None
    address = ", ".join(filter(None, (tags.get("addr:street"), tags.get("addr:housenumber")))) or None
    website = tags.get("website") or tags.get("contact:website")
    if website and not website.startswith(("https://", "http://")):
        website = None
    return {
        "id": f"{osm_type}/{osm_id}",
        "osm_type": osm_type,
        "osm_id": osm_id,
        "name": name.strip()[:300],
        "lat": lat,
        "lon": lon,
        "category": category,
        "tags": tags,
        "description": tags.get("description:ru") or tags.get("description"),
        "opening_hours": tags.get("opening_hours"),
        "address": address,
        "website": website,
        "phone": tags.get("phone") or tags.get("contact:phone"),
        "source_url": f"https://www.openstreetmap.org/{osm_type}/{osm_id}",
        "imported_at": imported_at,
        "search_text": fold(" ".join(tags.values())),
    }


def deduplicate(rows: list[dict]) -> list[dict]:
    # Prefer more complete records, then stable OSM identity. Never merge distant branches.
    rows = sorted(rows, key=lambda r: (-len(r["tags"]), r["id"]))
    kept, names, ids = [], {}, set()
    for row in rows:
        aliases = {name_key(row["name"])} | {
            name_key(name)
            for key, value in row["tags"].items()
            if key == "name" or key.startswith("name:") or key in {"alt_name", "int_name"}
            for name in value.split(";")
            if name.strip()
        }
        keys = [(alias, row["category"]) for alias in sorted(aliases)]
        if row["id"] in ids:
            continue
        ids.add(row["id"])
        if any(
            distance_m(row["lat"], row["lon"], old["lat"], old["lon"]) < 35
            for key in keys
            for old in names.get(key, [])
        ):
            continue
        kept.append(row)
        for key in keys:
            names.setdefault(key, []).append(row)
    return sorted(kept, key=lambda r: r["id"])


def build_query(bbox=ASTANA_BBOX) -> str:
    bounds = ",".join(map(str, bbox))
    filters = [
        '[leisure~"^(park|garden|nature_reserve|sports_centre|ice_rink|playground)$"]',
        '[tourism~"^(museum|gallery|attraction|viewpoint|artwork)$"]',
        '[historic~"^(monument|memorial)$"]',
        '[amenity~"^(cafe|theatre|arts_centre|library)$"]',
        "[shop=mall]",
        "[place=square]",
    ]
    return (
        "[out:json][timeout:60][maxsize:16777216];("
        + "".join(f'nwr{selector}[~"^name(:ru|:kk|:en)?$"~"."]({bounds});' for selector in filters)
        + ");out center tags;"
    )


def fetch_overpass(endpoints: list[str], client=None, sleep=time.sleep) -> tuple[dict, str]:
    own_client = client is None
    client = client or httpx.Client(
        timeout=httpx.Timeout(90, connect=15),
        headers={"User-Agent": "AITU-KEREK-LocalMVP/0.1 (educational Astana POI importer)"},
    )
    try:
        for endpoint in endpoints:
            for attempt in range(2):
                try:
                    logger.info("Fetching Astana POIs: %s (attempt %d/2)", endpoint, attempt + 1)
                    response = client.post(endpoint, data={"data": build_query()})
                    response.raise_for_status()
                    if len(response.content) > 20_000_000:
                        raise ValueError("Response exceeds 20 MB safety limit")
                    payload = response.json()
                    if (
                        payload.get("remark")
                        or not isinstance(payload.get("elements"), list)
                        or not payload["elements"]
                    ):
                        raise ValueError("Incomplete or empty Overpass response")
                    return payload, endpoint
                except (httpx.HTTPError, ValueError) as exc:
                    logger.warning("Import request failed (%s); existing database unchanged", type(exc).__name__)
                    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code not in {429, 502, 503, 504}:
                        break
                    if attempt == 0:
                        sleep(10)
            sleep(5)
    finally:
        if own_client:
            client.close()
    raise RuntimeError("All Overpass endpoints unavailable. Existing POIs preserved; retry later.")


def import_payload(session: Session, payload: dict, endpoint: str, snapshot_path: Path | None = None) -> ImportRun:
    if payload.get("remark") or not isinstance(payload.get("elements"), list):
        raise ValueError("Overpass response is incomplete")
    now = datetime.now(timezone.utc)
    rows = deduplicate([row for element in payload["elements"] if (row := normalize(element, now))])
    if not rows:
        raise ValueError("No valid POIs; existing database preserved")
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()
    # Save evidence before changing the DB; failed disk writes cannot mark a refresh successful.
    if snapshot_path:
        snapshot_path.parent.mkdir(parents=True, exist_ok=True)
        temp = snapshot_path.with_suffix(".tmp")
        temp.write_bytes(raw)
        temp.replace(snapshot_path)
    try:
        existing = {poi.id: poi for poi in session.scalars(select(POI))}
        for row in rows:
            if row["id"] in existing:
                for key, value in row.items():
                    setattr(existing[row["id"]], key, value)
            else:
                session.add(POI(**row))
        # A complete successful snapshot replaces the bounded dataset atomically.
        retained = {row["id"] for row in rows}
        stale = sorted(set(existing) - retained)
        for i in range(0, len(stale), 400):
            session.execute(delete(POI).where(POI.id.in_(stale[i : i + 400])))
        run = ImportRun(
            completed_at=now,
            endpoint=endpoint,
            bbox=list(ASTANA_BBOX),
            raw_count=len(payload["elements"]),
            poi_count=len(rows),
            payload_sha256=digest,
            osm_base_timestamp=payload.get("osm3s", {}).get("timestamp_osm_base"),
        )
        session.add(run)
        session.commit()
        session.refresh(run)
        return run
    except Exception:
        session.rollback()
        raise

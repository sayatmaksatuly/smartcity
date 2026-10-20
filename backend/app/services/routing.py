"""Bounded pedestrian routing: SQLite destinations, server-only ORS credentials.

No coordinate cache, user logs, retries, raw provider errors or synthetic geometry.
"""

import json
import math
import threading
import time
from collections import deque
from contextlib import contextmanager

import httpx
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import ASTANA_BBOX, Settings
from app.models import POI
from app.schemas import RouteGeometry, RouteRequest, RouteResponse
from app.services.geo import distance_m
from app.services.retrieval import VISIT_MINUTES

ORS_URL = "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"
MAX_RESPONSE_BYTES = 2_000_000
MAX_SNAP_METRES = 250
ERRORS = {
    "routing_not_configured": (503, "Пешеходные маршруты пока не настроены."),
    "routing_rate_limited": (429, "Слишком много запросов маршрута. Попробуйте через минуту."),
    "routing_busy": (503, "Построение маршрутов занято. Попробуйте чуть позже."),
    "routing_unavailable": (503, "Сервис маршрутов временно недоступен."),
    "routing_timeout": (504, "Сервис маршрутов не ответил вовремя."),
    "routing_invalid_response": (502, "Сервис маршрутов вернул неполный ответ."),
    "route_not_found": (422, "Доступный пешеходный маршрут между этими точками не найден."),
    "route_outside_area": (422, "Маршруты доступны внутри области Астаны, покрытой базой мест."),
    "route_too_long": (422, "Для одной прогулки выберите более близкие места."),
    "poi_not_found": (404, "Одно из мест больше не доступно в городской базе."),
}


class RouteError(Exception):
    def __init__(self, code: str):
        self.code = code
        self.status_code, self.message = ERRORS[code]
        super().__init__(code)


class RouteGate:
    """Per-process shared quota, with no IP addresses or other personal data."""

    def __init__(self):
        self._lock = threading.Lock()
        self._starts: deque[float] = deque()
        self._active = 0

    @contextmanager
    def acquire(self, per_minute: int):
        with self._lock:
            now = time.monotonic()
            while self._starts and self._starts[0] <= now - 60:
                self._starts.popleft()
            if len(self._starts) >= per_minute:
                raise RouteError("routing_rate_limited")
            if self._active >= 2:
                raise RouteError("routing_busy")
            self._starts.append(now)
            self._active += 1
        try:
            yield
        finally:
            with self._lock:
                self._active -= 1


route_gate = RouteGate()


def resolve_pois(session: Session, ids: list[str]) -> tuple[list[POI], list[str]]:
    ordered_ids = list(dict.fromkeys(ids))
    found = {poi.id: poi for poi in session.scalars(select(POI).where(POI.id.in_(ordered_ids)))}
    return [found[id_] for id_ in ordered_ids if id_ in found], [id_ for id_ in ordered_ids if id_ not in found]


def _inside_area(coordinate: tuple[float, float]) -> bool:
    lon, lat = coordinate
    south, west, north, east = ASTANA_BBOX
    return south <= lat <= north and west <= lon <= east


def _provider_error(status: int, payload: bytes):
    # Provider messages may echo requests or credentials: inspect numeric codes only.
    code = None
    try:
        error = json.loads(payload).get("error", {})
        if isinstance(error, dict):
            code = error.get("code")
    except (ValueError, AttributeError):
        pass
    if status == 429:
        raise RouteError("routing_rate_limited")
    if status in {400, 404} and type(code) is int and code in {2009, 2010}:
        raise RouteError("route_not_found")
    raise RouteError("routing_unavailable")


def fetch_route(coordinates: list[tuple[float, float]], settings: Settings) -> dict:
    """One HTTPS POST; credential stays in a header, never a URL or browser bundle."""
    try:
        with httpx.Client(
            timeout=httpx.Timeout(settings.ors_timeout_seconds, connect=min(5, settings.ors_timeout_seconds)),
            follow_redirects=False,
        ) as client:
            with client.stream(
                "POST",
                ORS_URL,
                headers={
                    "Authorization": settings.ors_api_key.get_secret_value(),
                    "Accept": "application/geo+json, application/json",
                },
                json={
                    "coordinates": coordinates,
                    "instructions": False,
                    "elevation": False,
                    "radiuses": [MAX_SNAP_METRES] * len(coordinates),
                },
            ) as response:
                chunks, size = [], 0
                deadline = time.monotonic() + settings.ors_timeout_seconds
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise RouteError("routing_invalid_response")
                    if time.monotonic() > deadline:
                        raise RouteError("routing_timeout")
                    chunks.append(chunk)
                raw = b"".join(chunks)
                if response.status_code != 200:
                    _provider_error(response.status_code, raw)
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise RouteError("routing_invalid_response")
                return payload
    except httpx.TimeoutException:
        raise RouteError("routing_timeout") from None
    except httpx.HTTPError:
        raise RouteError("routing_unavailable") from None
    except (ValueError, UnicodeError):
        raise RouteError("routing_invalid_response") from None


def _parse_route(payload: dict, coordinates: list[tuple[float, float]]) -> tuple[RouteGeometry, float, float]:
    try:
        if payload["type"] != "FeatureCollection" or len(payload["features"]) != 1:
            raise ValueError("invalid_features")
        feature = payload["features"][0]
        if feature["type"] != "Feature":
            raise ValueError("invalid_feature")
        geometry = RouteGeometry.model_validate(feature["geometry"])
        properties = feature["properties"]
        distance, duration = properties["summary"]["distance"], properties["summary"]["duration"]
        for number, maximum in [(distance, 100_000), (duration, 172_800)]:
            if type(number) not in {float, int} or not math.isfinite(number) or not 0 <= number <= maximum:
                raise ValueError("invalid_summary")
        indexes = properties["way_points"]
        if not isinstance(indexes, list) or len(indexes) != len(coordinates):
            raise ValueError("invalid_waypoints")
        previous = -1
        for index, (lon, lat) in zip(indexes, coordinates, strict=True):
            if type(index) is not int or not previous <= index < len(geometry.coordinates) or index < 0:
                raise ValueError("invalid_waypoint_index")
            snap_lon, snap_lat = geometry.coordinates[index]
            if distance_m(lat, lon, snap_lat, snap_lon) > MAX_SNAP_METRES + 5:
                raise ValueError("mismatched_waypoint")
            previous = index
        if indexes[0] != 0 or indexes[-1] != len(geometry.coordinates) - 1:
            raise ValueError("incomplete_geometry")
        return geometry, float(distance), float(duration)
    except (KeyError, IndexError, TypeError, ValueError, ValidationError):
        raise RouteError("routing_invalid_response") from None


def build_route(session: Session, request: RouteRequest, settings: Settings) -> RouteResponse:
    pois, missing = resolve_pois(session, request.poi_ids)
    if missing:
        raise RouteError("poi_not_found")
    coordinates = [(request.origin.lon, request.origin.lat), *((poi.lon, poi.lat) for poi in pois)]
    if request.round_trip:
        coordinates.append(coordinates[0])
    if not all(_inside_area(coordinate) for coordinate in coordinates):
        raise RouteError("route_outside_area")
    direct_distance = sum(
        distance_m(start[1], start[0], end[1], end[0]) for start, end in zip(coordinates, coordinates[1:])
    )
    if direct_distance > 50_000:
        raise RouteError("route_too_long")
    if not settings.ors_api_key.get_secret_value().strip():
        raise RouteError("routing_not_configured")
    with route_gate.acquire(settings.ors_requests_per_minute):
        payload = fetch_route(coordinates, settings)
        geometry, distance, duration = _parse_route(payload, coordinates)
    visit = sum(VISIT_MINUTES[poi.category] for poi in pois)
    total = math.ceil(duration / 60) + visit
    return RouteResponse(
        geometry=geometry,
        distance_m=distance,
        duration_seconds=duration,
        visit_minutes=visit,
        total_minutes=total,
        feasible=None if request.duration_minutes is None else total <= request.duration_minutes,
        poi_ids=request.poi_ids,
        round_trip=request.round_trip,
    )

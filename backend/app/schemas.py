from datetime import datetime, timezone
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Category(StrEnum):
    park = "park"
    culture = "culture"
    landmark = "landmark"
    cafe = "cafe"
    recreation = "recreation"
    venue = "venue"


class Position(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)


class RecommendationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    position: Position
    query: str = Field(default="", max_length=600)
    duration_minutes: int = Field(default=60, ge=15, le=240)
    categories: list[Category] = Field(default_factory=list, max_length=6)
    travel_mode: Literal["walking", "cycling"] = "walking"
    round_trip: bool = True
    open_now: bool = False
    free_only: bool = False


class POIOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    lat: float
    lon: float
    category: Category
    description: str | None
    opening_hours: str | None
    address: str | None
    website: str | None
    source_url: str
    imported_at: datetime

    @field_validator("imported_at")
    @classmethod
    def timestamp_utc(cls, value: datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


class Recommendation(BaseModel):
    poi: POIOut
    explanation: str
    activity: str
    straight_line_m: int
    travel_minutes_estimate: int
    visit_minutes_estimate: int
    total_minutes_estimate: int
    availability: Literal["open", "closed", "unknown"]
    facts: list[str]
    cautions: list[str]


class DataStatus(BaseModel):
    count: int
    last_import: datetime | None
    osm_base_timestamp: str | None
    source: str = "OpenStreetMap / Overpass API"
    license: str = "ODbL 1.0 · © OpenStreetMap contributors"
    bbox: tuple[float, float, float, float]
    ai_configured: bool

    @field_validator("last_import")
    @classmethod
    def timestamp_utc(cls, value: datetime | None):
        return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value


class RecommendationResponse(BaseModel):
    mode: Literal["gemini", "local"]
    fallback_reason: Literal["missing_key", "generation_failed", "no_candidates"] | None
    recommendations: list[Recommendation]
    message: str
    notices: list[str]
    candidate_count: int
    applied_categories: list[Category]
    applied_duration_minutes: int = 60
    suggested_duration_minutes: int | None = None
    origin_suggestions: list[POIOut] = Field(default_factory=list)
    data_status: DataStatus


class POIPage(BaseModel):
    items: list[POIOut]
    total: int
    limit: int
    offset: int


POIId = Annotated[str, Field(pattern=r"^(?:node|way|relation)/\d+$", max_length=40)]


class POIResolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    poi_ids: list[POIId] = Field(max_length=100)


class POIResolveResponse(BaseModel):
    items: list[POIOut]
    missing_ids: list[POIId]


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: Position
    poi_ids: list[POIId] = Field(min_length=1, max_length=3)
    duration_minutes: int | None = Field(default=None, ge=15, le=240)
    round_trip: bool = False

    @field_validator("poi_ids")
    @classmethod
    def unique_destinations(cls, value: list[str]):
        if len(set(value)) != len(value):
            raise ValueError("duplicate_destinations")
        return value


Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False, strict=True)]
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False, strict=True)]


class RouteGeometry(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: Literal["LineString"]
    # GeoJSON and ORS use longitude first; Leaflet conversion belongs in the UI.
    coordinates: list[tuple[Longitude, Latitude]] = Field(min_length=2, max_length=20000)


class RouteResponse(BaseModel):
    provider: Literal["openrouteservice"] = "openrouteservice"
    profile: Literal["foot-walking"] = "foot-walking"
    geometry: RouteGeometry
    distance_m: float
    duration_seconds: float
    visit_minutes: int
    total_minutes: int
    feasible: bool | None
    poi_ids: list[POIId]
    round_trip: bool
    attribution: str = "© openrouteservice.org by HeiGIT | © OpenStreetMap contributors"


class ChatPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    duration_minutes: int = Field(default=60, ge=15, le=240)
    categories: list[Category] = Field(default_factory=list, max_length=6)
    excluded_categories: list[Category] = Field(default_factory=list, max_length=6)
    travel_mode: Literal["walking", "cycling"] = "walking"
    round_trip: bool = True
    open_now: bool = False
    free_only: bool = False
    prefer_nearby: bool = False
    walking: bool = False
    relaxing: bool = False
    sightseeing: bool = False
    outdoor: bool = False
    artwork: bool = False


class ChatOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid")
    duration_minutes: int | None = Field(default=None, ge=15, le=240)
    categories: list[Category] | None = Field(default=None, max_length=6)
    travel_mode: Literal["walking", "cycling"] | None = None
    round_trip: bool | None = None
    open_now: bool | None = None
    free_only: bool | None = None


class ChatSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preferences: ChatPreferences
    shown_poi_ids: list[POIId] = Field(default_factory=list, max_length=3)


class ChatContext(BaseModel):
    """Bounded browser-carried state; no transcript, POI claims or coordinates."""

    model_config = ConfigDict(extra="forbid")
    preferences: ChatPreferences = Field(default_factory=ChatPreferences)
    shown_poi_ids: list[POIId] = Field(default_factory=list, max_length=3)
    seen_poi_ids: list[POIId] = Field(default_factory=list, max_length=96)
    selected_poi_id: POIId | None = None
    pending_origin_ids: list[POIId] = Field(default_factory=list, max_length=3)
    snapshots: list[ChatSnapshot] = Field(default_factory=list, max_length=8)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(default="", max_length=600)
    position: Position | None = None
    context: ChatContext | None = None
    overrides: ChatOverrides = Field(default_factory=ChatOverrides)
    selected_poi_id: POIId | None = None
    confirm_origin_id: POIId | None = None
    action: Literal["message", "confirm_origin", "previous", "select"] = "message"

    @model_validator(mode="after")
    def valid_action(self):
        self.message = self.message.strip()
        if self.action == "message" and not self.message:
            raise ValueError("empty_message")
        if self.action == "confirm_origin" and self.confirm_origin_id is None:
            raise ValueError("missing_origin")
        if self.action == "select" and self.selected_poi_id is None:
            raise ValueError("missing_selection")
        return self


class ChatResponse(BaseModel):
    message: str
    action: Literal[
        "recommendations", "clarify_origin", "confirm_origin", "unsupported", "selected", "previous_unavailable"
    ]
    context: ChatContext
    recommendation_response: RecommendationResponse | None = None
    origin_suggestions: list[POIOut] = Field(default_factory=list)
    position: Position | None = None
    selected_poi_id: POIId | None = None

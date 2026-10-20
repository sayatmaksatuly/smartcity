from datetime import datetime

from sqlalchemy import JSON, DateTime, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class POI(Base):
    __tablename__ = "pois"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    osm_type: Mapped[str] = mapped_column(String(16))
    osm_id: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(300))
    lat: Mapped[float] = mapped_column(Float, index=True)
    lon: Mapped[float] = mapped_column(Float, index=True)
    category: Mapped[str] = mapped_column(String(32), index=True)
    tags: Mapped[dict] = mapped_column(JSON)
    description: Mapped[str | None] = mapped_column(Text)
    opening_hours: Mapped[str | None] = mapped_column(String(500))
    address: Mapped[str | None] = mapped_column(String(500))
    website: Mapped[str | None] = mapped_column(String(1000))
    phone: Mapped[str | None] = mapped_column(String(200))
    source_url: Mapped[str] = mapped_column(String(200))
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    search_text: Mapped[str] = mapped_column(Text)


class ImportRun(Base):
    __tablename__ = "import_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    completed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    endpoint: Mapped[str] = mapped_column(String(300))
    bbox: Mapped[list] = mapped_column(JSON)
    raw_count: Mapped[int] = mapped_column(Integer)
    poi_count: Mapped[int] = mapped_column(Integer)
    payload_sha256: Mapped[str] = mapped_column(String(64))
    osm_base_timestamp: Mapped[str | None] = mapped_column(String(100))

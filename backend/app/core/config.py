from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = BACKEND_DIR / "data"
ASTANA_BBOX = (51.00, 71.25, 51.25, 71.65)  # south, west, north, east


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")
    database_url: str = f"sqlite:///{(DATA_DIR / 'astana.db').as_posix()}"
    gemini_api_key: SecretStr = SecretStr("")
    gemini_model: str = "gemini-flash-latest"
    ors_api_key: SecretStr = SecretStr("")
    ors_timeout_seconds: float = Field(default=15, ge=1, le=30)
    ors_requests_per_minute: int = Field(default=20, ge=1, le=60)
    generation_requests_per_minute: int = Field(default=30, ge=1, le=120)
    cors_origins: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]
    overpass_endpoints: list[str] = [
        "https://overpass-api.de/api/interpreter",
        "https://overpass.kumi.systems/api/interpreter",
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()

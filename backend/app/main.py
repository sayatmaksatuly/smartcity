from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.db import get_session, init_db
from app.models import POI
from app.schemas import (
    Category,
    ChatRequest,
    ChatResponse,
    DataStatus,
    POIPage,
    POIResolveRequest,
    POIResolveResponse,
    RecommendationRequest,
    RecommendationResponse,
    RouteRequest,
    RouteResponse,
)
from app.services.chat import chat
from app.services.importer import fold
from app.services.limits import RequestGate, RequestLimitError
from app.services.recommendations import data_status, recommend
from app.services.routing import RouteError, build_route, resolve_pois

generation_gate = RequestGate()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    generation_gate.reset()
    yield


app = FastAPI(title="AITU KEREK — Astana city guide", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
SessionDep = Annotated[Session, Depends(get_session)]


def limit_generation():
    try:
        with generation_gate.acquire(get_settings().generation_requests_per_minute):
            yield
    except RequestLimitError as exc:
        if str(exc) == "rate_limited":
            raise HTTPException(429, "Слишком много запросов. Попробуйте через минуту.",
                                headers={"Retry-After": "60"}) from None
        raise HTTPException(503, "Подбор мест занят. Попробуйте чуть позже.") from None


GenerationDep = Annotated[None, Depends(limit_generation)]


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, _exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"detail": "Проверьте координаты, фильтры и время (15–240 минут). Запрос — не более 600 символов."},
    )


@app.get("/api/health")
def health(session: SessionDep):
    session.execute(select(1))
    return {"status": "ok", "service": "aitu-kerek", "version": "0.1.0"}


@app.get("/api/data-status", response_model=DataStatus)
def status(session: SessionDep):
    return data_status(session, get_settings())


@app.get("/api/pois", response_model=POIPage)
def pois(
    session: SessionDep,
    q: str = Query(default="", max_length=100),
    category: Category | None = None,
    limit: int = Query(default=30, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=10000),
    south: float = Query(default=51.00, ge=-90, le=90),
    north: float = Query(default=51.25, ge=-90, le=90),
    west: float = Query(default=71.25, ge=-180, le=180),
    east: float = Query(default=71.65, ge=-180, le=180),
):
    if south > north or west > east:
        raise HTTPException(422, "Некорректная область карты.")
    statement = select(POI).where(POI.lat.between(south, north), POI.lon.between(west, east))
    if q.strip():
        # Tokens are ANDed; literal LIKE escaping prevents wildcard-only queries.
        for token in fold(q).split():
            statement = statement.where(POI.search_text.contains(token, autoescape=True))
    if category:
        statement = statement.where(POI.category == category)
    count = session.scalar(select(func.count()).select_from(statement.subquery())) or 0
    items = session.scalars(statement.order_by(POI.name, POI.id).offset(offset).limit(limit)).all()
    return POIPage(items=items, total=count, limit=limit, offset=offset)


@app.post("/api/recommendations", response_model=RecommendationResponse)
def recommendations(request: RecommendationRequest, session: SessionDep, _guard: GenerationDep):
    return recommend(session, request, get_settings())


@app.post("/api/chat", response_model=ChatResponse)
def conversation(request: ChatRequest, session: SessionDep, _guard: GenerationDep):
    return chat(session, request, get_settings())


@app.post("/api/pois/resolve", response_model=POIResolveResponse)
def resolve_places(request: POIResolveRequest, session: SessionDep):
    items, missing = resolve_pois(session, request.poi_ids)
    return POIResolveResponse(items=items, missing_ids=missing)


@app.post("/api/routes", response_model=RouteResponse)
def routes(request: RouteRequest, session: SessionDep):
    try:
        return build_route(session, request, get_settings())
    except RouteError as exc:
        headers = {"Retry-After": "60"} if exc.status_code == 429 else {}
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": {"code": exc.code, "message": exc.message}},
            headers=headers,
        )

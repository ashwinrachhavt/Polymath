"""Polymath Python sidecar (ADR 0008).

A capability service, not a second orchestrator: Eve and the Next app hand it
bounded units of work; product authority, canonical schema and external
effects stay in the TypeScript app.
"""

from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import require_token
from .config import Settings, get_settings
from .db import make_engine, make_sessionmaker, session_scope
from .models import Job


class JobCreate(BaseModel):
    workspace_id: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=64)
    payload: dict = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=1, max_length=128)


class JobOut(BaseModel):
    id: str
    workspace_id: str
    kind: str
    payload: dict
    idempotency_key: str
    status: str
    replayed: bool


def job_out(job: Job, replayed: bool) -> JobOut:
    return JobOut(
        id=job.id,
        workspace_id=job.workspace_id,
        kind=job.kind,
        payload=job.payload,
        idempotency_key=job.idempotency_key,
        status=job.status,
        replayed=replayed,
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = make_engine(settings.database_url)
    sessions = make_sessionmaker(engine)
    app = FastAPI(title="polymath-sidecar", version="0.1.0")
    app.state.settings = settings
    app.state.engine = engine
    app.state.sessions = sessions

    async def get_session() -> AsyncSession:
        async for session in session_scope(sessions):
            return session
        raise RuntimeError("unreachable")

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": "polymath-sidecar"}

    @app.post("/v1/jobs", response_model=JobOut, status_code=201,
              dependencies=[Depends(require_token)])
    async def create_job(body: JobCreate, session: AsyncSession = Depends(get_session)) -> JobOut:
        job = Job(
            id=str(uuid4()),
            workspace_id=body.workspace_id,
            kind=body.kind,
            payload=body.payload,
            idempotency_key=body.idempotency_key,
            status="queued",
        )
        session.add(job)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            existing = await session.scalar(
                select(Job).where(
                    Job.workspace_id == body.workspace_id,
                    Job.idempotency_key == body.idempotency_key,
                )
            )
            if existing is None:  # pragma: no cover - defensive
                raise HTTPException(
                    status_code=500, detail="idempotency conflict without row"
                ) from None
            return job_out(existing, replayed=True)
        return job_out(job, replayed=False)

    @app.get("/v1/jobs/{job_id}", response_model=JobOut, dependencies=[Depends(require_token)])
    async def get_job(
        job_id: str, workspace_id: str, session: AsyncSession = Depends(get_session)
    ) -> JobOut:
        job = await session.scalar(
            select(Job).where(Job.id == job_id, Job.workspace_id == workspace_id)
        )
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        return job_out(job, replayed=False)

    return app


app = create_app()

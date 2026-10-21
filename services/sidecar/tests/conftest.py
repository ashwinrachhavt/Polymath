"""Unit tests run on SQLite (no Postgres needed). Tests that need pgvector
skip unless SIDECAR_TEST_DATABASE_URL points at a real Postgres with the
vector extension available — CI always provides one."""

import os

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import Settings
from app.db import make_engine, make_sessionmaker
from app.main import create_app
from app.models import Base, Job

TEST_TOKEN = "test-token"
TEST_WORKSPACE = "ws-test"


@pytest.fixture
async def client(tmp_path):
    settings = Settings(
        database_url=f"sqlite+aiosqlite:///{tmp_path}/test.db",
        sidecar_token=TEST_TOKEN,
    )
    app = create_app(settings)
    engine = app.state.engine
    async with engine.begin() as conn:
        await conn.run_sync(lambda c: Base.metadata.create_all(c, tables=[Job.__table__]))
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http
    await engine.dispose()


@pytest.fixture
def auth_headers():
    return {"Authorization": f"Bearer {TEST_TOKEN}"}


@pytest.fixture
async def pg_engine():
    url = os.environ.get("SIDECAR_TEST_DATABASE_URL")
    if not url:
        pytest.skip("SIDECAR_TEST_DATABASE_URL not set")
    engine = make_engine(url)
    yield engine
    await engine.dispose()


@pytest.fixture
def pg_sessions(pg_engine):
    return make_sessionmaker(pg_engine)

"""pgvector round-trip against real Postgres (CI provides the service).
Skipped locally unless SIDECAR_TEST_DATABASE_URL is set."""

from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Base, EmbeddingChunk


async def test_pgvector_create_and_cosine_ordering(pg_engine, pg_sessions):
    async with pg_engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text("TRUNCATE embedding_chunks"))

    near = [1.0] + [0.0] * 1535
    far = [0.0, 1.0] + [0.0] * 1534
    async with pg_sessions() as session:
        assert isinstance(session, AsyncSession)
        session.add_all([
            EmbeddingChunk(
                id=str(uuid4()), workspace_id="ws-test", model="openai:text-embedding-3-small",
                content="near", embedding=near,
            ),
            EmbeddingChunk(
                id=str(uuid4()), workspace_id="ws-test", model="openai:text-embedding-3-small",
                content="far", embedding=far,
            ),
        ])
        await session.commit()

    async with pg_sessions() as session:
        rows = (
            await session.execute(
                text(
                    "SELECT content FROM embedding_chunks "
                    "WHERE workspace_id = 'ws-test' "
                    "ORDER BY embedding <=> :query LIMIT 1"
                ),
                {"query": str(near)},
            )
        ).all()
    assert rows[0][0] == "near"

    async with pg_engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

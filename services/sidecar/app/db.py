"""Async engine/session helpers.

Sidecar-owned state lives in the Postgres schema `sidecar` on the same Neon
database as the canonical app data (ADR 0008). Canonical tables and their
migrations stay owned by Drizzle in the Next.js app; nothing here touches them.

On Postgres connections we create the schema if needed and scope the search
path. SQLite (unit tests) has no schemas, so the hook is Postgres-only.
"""

from collections.abc import AsyncIterator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

PG_SCHEMA = "sidecar"


def make_engine(url: str) -> AsyncEngine:
    engine = create_async_engine(url, pool_pre_ping=True)
    if engine.dialect.name == "postgresql":

        @event.listens_for(engine.sync_engine, "connect")
        def _prepare_schema(dbapi_connection, _):  # type: ignore[no-untyped-def]
            cursor = dbapi_connection.cursor()
            cursor.execute(f"CREATE SCHEMA IF NOT EXISTS {PG_SCHEMA}")
            cursor.execute(f"SET search_path TO {PG_SCHEMA}, public")
            cursor.close()

    return engine


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def session_scope(factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with factory() as session:
        yield session

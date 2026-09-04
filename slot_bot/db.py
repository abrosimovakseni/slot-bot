"""
Database engine / session setup.

Kept deliberately small: one function to normalize a DATABASE_URL into the
asyncpg-flavoured URL SQLAlchemy needs, and one function to build an engine
+ session factory from any URL (used both by the running bot and by tests,
which point at a separate test database).
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from .models import Base


def normalize_database_url(url: str) -> str:
    """Turn a plain postgres:// / postgresql:// URL (what Railway gives you)
    into the postgresql+asyncpg:// form SQLAlchemy's async engine needs."""
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    if url.startswith("postgresql://") and "+asyncpg" not in url:
        url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
    return url


def make_engine(database_url: str) -> AsyncEngine:
    return create_async_engine(normalize_database_url(database_url), pool_pre_ping=True)


def make_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def init_models(engine: AsyncEngine) -> None:
    """Create all tables/constraints/indexes if they don't already exist.

    Safe to call every time the app starts -- CREATE TABLE/INDEX IF NOT
    EXISTS semantics via SQLAlchemy's create_all, so this never touches
    existing data.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

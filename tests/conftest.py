import os

import pytest_asyncio

from slot_bot.db import make_engine, make_session_factory
from slot_bot.models import Base

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/slot_test"
)


@pytest_asyncio.fixture
async def session_factory():
    """Fresh schema for every test: drop + recreate all tables against a
    real local PostgreSQL database. Using real Postgres (not SQLite) is
    what makes the concurrency/locking tests meaningful."""
    engine = make_engine(TEST_DATABASE_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    factory = make_session_factory(engine)
    try:
        yield factory
    finally:
        await engine.dispose()

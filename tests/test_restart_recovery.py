"""TEST 16: after a simulated app restart (a brand new engine/connection
pool pointed at the same database, exactly like a fresh Railway deploy),
users, queue state, and priority statuses must all still be there -- because
none of it ever lived anywhere but PostgreSQL."""
from __future__ import annotations

from slot_bot.db import make_engine, make_session_factory
from slot_bot.models import PriorityStatus
from slot_bot.services.queue import get_my_position, get_queue_view, signup_user
from slot_bot.services.users import get_user

from .conftest import TEST_DATABASE_URL
from .helpers import create_open_consultation, make_user

P = PriorityStatus.PRIORITY.value


async def test_state_survives_a_fresh_engine_reconnect(session_factory):
    await make_user(session_factory, 1, "Ксения Абросимова", status=P)
    await make_user(session_factory, 2, "Анна Иванова", status=P)
    consultation_id = await create_open_consultation(session_factory)
    async with session_factory() as session:
        await signup_user(session, consultation_id, 1)
        await signup_user(session, consultation_id, 2)

    # Simulate a full process restart: brand new engine/connection pool,
    # nothing shared in memory with what created the data above.
    fresh_engine = make_engine(TEST_DATABASE_URL)
    fresh_session_factory = make_session_factory(fresh_engine)
    try:
        async with fresh_session_factory() as session:
            user1 = await get_user(session, 1)
            assert user1 is not None
            assert user1.display_name == "Ксения Абросимова"
            assert user1.priority_status == P

            entries = await get_queue_view(session, consultation_id)
            assert [e.user_id for e in entries if not e.is_placeholder] == [1, 2]

            pos1 = await get_my_position(session, consultation_id, 1)
            assert pos1.position == 1
    finally:
        await fresh_engine.dispose()

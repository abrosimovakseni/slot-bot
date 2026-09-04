"""TEST 17: finalizing a consultation twice (sequentially, and genuinely
concurrently) must only toggle each user's status once."""
from __future__ import annotations

import asyncio

from slot_bot.models import PriorityStatus
from slot_bot.services.consultations import finalize_consultation
from slot_bot.services.queue import signup_user

from .helpers import create_open_consultation, get_user_status, make_user

P = PriorityStatus.PRIORITY.value
R = PriorityStatus.RESTRICTED.value


async def test_sequential_double_finalize_toggles_only_once(session_factory):
    await make_user(session_factory, 1, status=P)
    consultation_id = await create_open_consultation(session_factory)
    async with session_factory() as session:
        await signup_user(session, consultation_id, 1)

    async with session_factory() as session:
        first = await finalize_consultation(session, consultation_id)
    async with session_factory() as session:
        second = await finalize_consultation(session, consultation_id)

    assert first.already_finalized is False
    assert first.toggled_user_ids == [1]
    assert second.already_finalized is True
    assert second.toggled_user_ids == []
    assert await get_user_status(session_factory, 1) == R  # toggled exactly once


async def test_concurrent_double_finalize_toggles_only_once(session_factory):
    await make_user(session_factory, 1, status=P)
    consultation_id = await create_open_consultation(session_factory)
    async with session_factory() as session:
        await signup_user(session, consultation_id, 1)

    async def run():
        async with session_factory() as session:
            return await finalize_consultation(session, consultation_id)

    results = await asyncio.gather(run(), run(), run(), run())
    finalized_count = sum(1 for r in results if not r.already_finalized)
    assert finalized_count == 1
    assert await get_user_status(session_factory, 1) == R

"""TEST 14, 15: real concurrent requests against real PostgreSQL.

These tests fire many genuinely-concurrent coroutines, each with its own
DB session/connection (via asyncio.gather), to exercise the row-locking
in services/queue.py under actual contention -- not just sequential calls.
"""
from __future__ import annotations

import asyncio

from sqlalchemy import func, select

from slot_bot.models import PriorityStatus, Signup
from slot_bot.services.queue import signup_user

from .helpers import create_open_consultation, make_user

P = PriorityStatus.PRIORITY.value


async def test_many_simultaneous_signups_from_the_same_user_produce_one_row(session_factory):
    # TEST 14: one user's button mashing / double-tap must never create two
    # active signups.
    consultation_id = await create_open_consultation(session_factory)
    await make_user(session_factory, 1, status=P)

    async def attempt():
        async with session_factory() as session:
            return await signup_user(session, consultation_id, 1)

    results = await asyncio.gather(*[attempt() for _ in range(25)], return_exceptions=True)
    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, f"unexpected errors: {errors}"

    successes = [r for r in results if not r.already_signed_up]
    already = [r for r in results if r.already_signed_up]
    assert len(successes) == 1
    assert len(already) == 24

    async with session_factory() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(Signup)
            .where(Signup.consultation_id == consultation_id, Signup.user_id == 1, Signup.active.is_(True))
        )
    assert count == 1


async def test_many_different_users_signing_up_simultaneously_no_corruption(session_factory):
    # TEST 15: many distinct users hitting "Записаться" at once must all
    # get exactly one signup each, with a clean, gap-free, duplicate-free
    # set of positions 1..N -- no lost signups, no duplicate positions.
    consultation_id = await create_open_consultation(session_factory)
    n = 40
    for i in range(1, n + 1):
        status = P if i % 2 == 0 else PriorityStatus.RESTRICTED.value
        await make_user(session_factory, i, f"User{i}", status=status)

    async def attempt(user_id: int):
        async with session_factory() as session:
            return await signup_user(session, consultation_id, user_id)

    results = await asyncio.gather(*[attempt(i) for i in range(1, n + 1)], return_exceptions=True)
    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, f"unexpected errors: {errors}"
    assert all(not r.already_signed_up for r in results)

    async with session_factory() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(Signup)
            .where(Signup.consultation_id == consultation_id, Signup.active.is_(True))
        )
    assert count == n

    positions = sorted(r.position for r in results)
    assert positions == list(range(1, n + 1))  # no duplicates, no gaps

    # Exactly PRIORITY_SLOTS (5) of the first five priority-eligible slots
    # must be occupied by users whose status_at_signup is PRIORITY.
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Signup).where(Signup.consultation_id == consultation_id, Signup.active.is_(True))
            )
        ).scalars().all()
    from slot_bot.services.queue import compute_positions

    computed = compute_positions(list(rows))
    top5_statuses = {
        s.status_at_signup for s in rows if computed[s.id] <= 5
    }
    assert top5_statuses == {P}

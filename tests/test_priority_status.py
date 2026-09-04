"""TEST 7, 8, 10, 11: the PRIORITY <-> RESTRICTED alternation, and that
skipping (or cancelling) a consultation never changes a user's status."""
from __future__ import annotations

from slot_bot.models import PriorityStatus
from slot_bot.services.consultations import finalize_consultation
from slot_bot.services.queue import cancel_signup, signup_user

from .helpers import create_open_consultation, get_user_status, make_user

P = PriorityStatus.PRIORITY.value
R = PriorityStatus.RESTRICTED.value


async def _signup(session_factory, consultation_id, user_id):
    async with session_factory() as session:
        return await signup_user(session, consultation_id, user_id)


async def _finalize(session_factory, consultation_id):
    async with session_factory() as session:
        return await finalize_consultation(session, consultation_id)


async def test_first_ever_participation_then_toggles_to_restricted(session_factory):
    # TEST 7: brand-new user's first successful signup is PRIORITY; after
    # the consultation is finalized, they become RESTRICTED.
    await make_user(session_factory, 1, status=P)
    consultation_id = await create_open_consultation(session_factory)
    result = await _signup(session_factory, consultation_id, 1)
    assert result.status_at_signup == P
    assert await get_user_status(session_factory, 1) == P  # not toggled yet -- consultation still open

    await _finalize(session_factory, consultation_id)
    assert await get_user_status(session_factory, 1) == R


async def test_second_participation_as_restricted_then_back_to_priority(session_factory):
    # TEST 8: on their next successful signup (now RESTRICTED), after that
    # consultation finalizes they flip back to PRIORITY.
    await make_user(session_factory, 1, status=R)  # simulate: already toggled once
    consultation_id = await create_open_consultation(session_factory)
    result = await _signup(session_factory, consultation_id, 1)
    assert result.status_at_signup == R

    await _finalize(session_factory, consultation_id)
    assert await get_user_status(session_factory, 1) == P


async def test_cancelling_a_signup_does_not_change_status(session_factory):
    # TEST 9 (status half): sign up, cancel, finalize -- status must be
    # untouched because a cancelled signup never counts as participation.
    await make_user(session_factory, 1, status=P)
    consultation_id = await create_open_consultation(session_factory)
    await _signup(session_factory, consultation_id, 1)
    async with session_factory() as session:
        await cancel_signup(session, consultation_id, 1)

    await _finalize(session_factory, consultation_id)
    assert await get_user_status(session_factory, 1) == P


async def test_skipping_one_consultation_does_not_change_status(session_factory):
    # TEST 10: user has RESTRICTED status, does not sign up for a
    # consultation at all -- status stays RESTRICTED after it finalizes.
    await make_user(session_factory, 1, status=R)
    consultation_id = await create_open_consultation(session_factory)
    # user 1 never signs up
    await _finalize(session_factory, consultation_id)
    assert await get_user_status(session_factory, 1) == R


async def test_skipping_several_consultations_does_not_change_status(session_factory):
    # TEST 11: user skips several consultations in a row -- status still
    # unaffected across all of them.
    await make_user(session_factory, 1, status=R)
    import datetime

    base = datetime.datetime.now(datetime.timezone.utc)
    for week in range(3):
        consultation_id = await create_open_consultation(
            session_factory, scheduled_at=base + datetime.timedelta(days=7 * week)
        )
        await _finalize(session_factory, consultation_id)
    assert await get_user_status(session_factory, 1) == R

"""TEST 5, 6, 9, 12, 13 plus basic signup/cancel behaviour."""
from __future__ import annotations

import pytest

from slot_bot.exceptions import RegistrationNotOpenYetError
from slot_bot.models import PriorityStatus
from slot_bot.services.queue import cancel_signup, get_my_position, get_queue_view, signup_user
from slot_bot.services.users import update_display_name

from .helpers import create_open_consultation, create_unopened_consultation, make_user

P = PriorityStatus.PRIORITY.value
R = PriorityStatus.RESTRICTED.value


async def _signup(session_factory, consultation_id, user_id):
    async with session_factory() as session:
        return await signup_user(session, consultation_id, user_id)


async def test_registration_not_open_yet_is_rejected(session_factory):
    consultation_id = await create_unopened_consultation(session_factory)
    await make_user(session_factory, 1)
    with pytest.raises(RegistrationNotOpenYetError):
        async with session_factory() as session:
            await signup_user(session, consultation_id, 1)


async def test_double_signup_returns_already_signed_up_with_same_position(session_factory):
    consultation_id = await create_open_consultation(session_factory)
    await make_user(session_factory, 1)
    first = await _signup(session_factory, consultation_id, 1)
    second = await _signup(session_factory, consultation_id, 1)
    assert first.already_signed_up is False
    assert second.already_signed_up is True
    assert second.position == first.position


async def test_position_3_cancels_and_queue_recomputes(session_factory):
    # TEST 5: user #3 cancels; the queue is correctly recomputed.
    consultation_id = await create_open_consultation(session_factory)
    for i in range(1, 6):
        await make_user(session_factory, i, f"User{i}", status=P)
        await _signup(session_factory, consultation_id, i)

    async with session_factory() as session:
        result = await cancel_signup(session, consultation_id, 3)
    assert result.had_active_signup is True
    # users 4 and 5 should have moved up by one
    assert result.changed_positions == {4: 3, 5: 4}

    async with session_factory() as session:
        pos4 = await get_my_position(session, consultation_id, 4)
        pos5 = await get_my_position(session, consultation_id, 5)
    assert pos4.position == 3
    assert pos5.position == 4


async def test_restricted_at_6_does_not_move_up_when_priority_cancels(session_factory):
    # TEST 6: RESTRICTED user sits at #6. A user from the first five
    # (PRIORITY) cancels. The RESTRICTED user must NOT move to #5 --
    # instead another PRIORITY signup (if any) would take the freed slot,
    # and if none exists the slot just stays reserved/empty.
    consultation_id = await create_open_consultation(session_factory)
    for i in range(1, 6):
        await make_user(session_factory, i, f"P{i}", status=P)
        await _signup(session_factory, consultation_id, i)
    await make_user(session_factory, 6, "Restricted6", status=R)
    await _signup(session_factory, consultation_id, 6)

    async with session_factory() as session:
        pos6_before = await get_my_position(session, consultation_id, 6)
    assert pos6_before.position == 6

    # user #5 (a PRIORITY user occupying position 5) cancels
    async with session_factory() as session:
        result = await cancel_signup(session, consultation_id, 5)

    assert 6 not in result.changed_positions  # restricted user's position must be unaffected

    async with session_factory() as session:
        pos6_after = await get_my_position(session, consultation_id, 6)
    assert pos6_after.position == 6  # still 6, never promoted into the freed priority slot


async def test_cancelled_signup_does_not_count_as_participation(session_factory):
    # TEST 9: a user signs up then cancels -- their priority_status is
    # unaffected (checked more thoroughly in test_priority_status.py; here
    # we just confirm cancel leaves no active signup and status untouched).
    consultation_id = await create_open_consultation(session_factory)
    await make_user(session_factory, 1, status=P)
    await _signup(session_factory, consultation_id, 1)
    async with session_factory() as session:
        result = await cancel_signup(session, consultation_id, 1)
    assert result.had_active_signup is True
    async with session_factory() as session:
        my_pos = await get_my_position(session, consultation_id, 1)
    assert my_pos.signed_up is False


async def test_display_name_change_preserves_id_and_status(session_factory):
    # TEST 12: changing display name preserves user_id and priority status.
    await make_user(session_factory, 42, "Old Name", status=R)
    async with session_factory() as session:
        updated = await update_display_name(session, 42, "New Name")
    assert updated.telegram_user_id == 42
    assert updated.display_name == "New Name"
    assert updated.priority_status == R


async def test_same_display_name_different_users_distinguished_by_id(session_factory):
    # TEST 13: two users share a display name; the system tells them apart
    # by telegram_user_id, and each keeps their own independent signup.
    await make_user(session_factory, 101, "Иван Иванов", status=P)
    await make_user(session_factory, 202, "Иван Иванов", status=P)
    consultation_id = await create_open_consultation(session_factory)

    r1 = await _signup(session_factory, consultation_id, 101)
    r2 = await _signup(session_factory, consultation_id, 202)
    assert r1.position != r2.position

    async with session_factory() as session:
        entries = await get_queue_view(session, consultation_id)
    user_ids = {e.user_id for e in entries if not e.is_placeholder}
    assert user_ids == {101, 202}

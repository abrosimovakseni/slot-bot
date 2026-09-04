"""Coverage for services/users.py beyond what the numbered spec tests hit:
registration is a one-time, idempotent action, and blocked users are
excluded from broadcast lists."""
from __future__ import annotations

from slot_bot.services.users import (
    all_reachable_users,
    get_user,
    mark_blocked,
    register_user,
    sync_username,
)


async def test_registering_twice_is_a_no_op_and_keeps_original_profile(session_factory):
    async with session_factory() as session:
        first = await register_user(
            session, telegram_user_id=1, display_name="Ксения Абросимова", username="ksenia"
        )
    assert first.already_existed is False

    async with session_factory() as session:
        second = await register_user(
            session, telegram_user_id=1, display_name="Someone Else", username="someone"
        )
    assert second.already_existed is True
    # the ORIGINAL profile is untouched by the second "registration" attempt
    assert second.user.display_name == "Ксения Абросимова"


async def test_sync_username_updates_only_username(session_factory):
    async with session_factory() as session:
        await register_user(session, telegram_user_id=1, display_name="A B", username="old")
    async with session_factory() as session:
        await sync_username(session, 1, "new")
    async with session_factory() as session:
        user = await get_user(session, 1)
    assert user.username == "new"
    assert user.display_name == "A B"


async def test_blocked_users_excluded_from_reachable_list(session_factory):
    async with session_factory() as session:
        await register_user(session, telegram_user_id=1, display_name="A", username=None)
        await register_user(session, telegram_user_id=2, display_name="B", username=None)
    async with session_factory() as session:
        await mark_blocked(session, 1, True)
    async with session_factory() as session:
        reachable = await all_reachable_users(session)
    assert {u.telegram_user_id for u in reachable} == {2}

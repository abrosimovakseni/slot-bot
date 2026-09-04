"""TEST 1-4 from the spec: the core PRIORITY 1-5 / RESTRICTED 6+ ordering
rule, both as a pure function and end-to-end through signup_user()."""
from __future__ import annotations

from slot_bot.models import PriorityStatus, Signup
from slot_bot.services.queue import compute_positions, get_queue_view, signup_user

from .helpers import create_open_consultation, make_user

P = PriorityStatus.PRIORITY.value
R = PriorityStatus.RESTRICTED.value


def _signup(id_, status):
    s = Signup(id=id_, consultation_id=1, user_id=id_, status_at_signup=status, active=True)
    return s


def test_pure_five_priority_users_get_1_to_5_in_order():
    # TEST 1: five new PRIORITY users sign up -> positions 1..5 by signup time.
    signups = [_signup(i, P) for i in range(1, 6)]
    positions = compute_positions(signups)
    assert [positions[s.id] for s in signups] == [1, 2, 3, 4, 5]


def test_pure_restricted_first_then_one_priority():
    # TEST 2: RESTRICTED clicks first, then one PRIORITY signs up.
    # RESTRICTED must NOT get #1; PRIORITY gets #1; RESTRICTED gets #6.
    restricted = _signup(1, R)
    priority = _signup(2, P)
    positions = compute_positions([restricted, priority])
    assert positions[priority.id] == 1
    assert positions[restricted.id] == 6


def test_pure_restricted_first_then_five_priority():
    # TEST 3: RESTRICTED first, then five PRIORITY -> the five PRIORITY take
    # 1-5, RESTRICTED gets 6.
    restricted = _signup(1, R)
    priorities = [_signup(i, P) for i in range(2, 7)]
    positions = compute_positions([restricted, *priorities])
    assert [positions[s.id] for s in priorities] == [1, 2, 3, 4, 5]
    assert positions[restricted.id] == 6


def test_pure_sixth_priority_no_longer_has_advantage():
    # TEST 4: once 1-5 are filled by PRIORITY users, a 6th PRIORITY signup
    # does NOT jump ahead of an earlier RESTRICTED signup -- position 6+ is
    # strictly chronological regardless of status.
    restricted = _signup(1, R)  # 09:30:01 Аня
    priorities = [_signup(i, P) for i in range(2, 8)]  # Маша..Ира (6 priority users)
    positions = compute_positions([restricted, *priorities])
    assert [positions[s.id] for s in priorities[:5]] == [1, 2, 3, 4, 5]
    assert positions[restricted.id] == 6
    assert positions[priorities[5].id] == 7  # Ира: 6th priority, arrived after restricted


def test_pure_worked_example_from_spec():
    # The exact walk-through example from the spec:
    # 09:30:01 Аня RESTRICTED, 09:30:02 Маша PRIORITY, 09:30:03 Ксюша PRIORITY
    # -> 1.Маша 2.Ксюша, 3-5 reserved/empty, 6.Аня
    ana = _signup(1, R)
    masha = _signup(2, P)
    ksyusha = _signup(3, P)
    positions = compute_positions([ana, masha, ksyusha])
    assert positions[masha.id] == 1
    assert positions[ksyusha.id] == 2
    assert positions[ana.id] == 6

    # Then Лиза, Соня, Даша (all PRIORITY) sign up later.
    liza = _signup(4, P)
    sonya = _signup(5, P)
    dasha = _signup(6, P)
    positions2 = compute_positions([ana, masha, ksyusha, liza, sonya, dasha])
    assert positions2[masha.id] == 1
    assert positions2[ksyusha.id] == 2
    assert positions2[liza.id] == 3
    assert positions2[sonya.id] == 4
    assert positions2[dasha.id] == 5
    assert positions2[ana.id] == 6


async def test_end_to_end_five_priority_signups_via_service(session_factory):
    consultation_id = await create_open_consultation(session_factory)
    positions = []
    for i in range(1, 6):
        await make_user(session_factory, user_id=i, name=f"User{i}", status=P)
        async with session_factory() as session:
            result = await signup_user(session, consultation_id, i)
        positions.append(result.position)
    assert positions == [1, 2, 3, 4, 5]


async def test_end_to_end_queue_view_shows_placeholders(session_factory):
    consultation_id = await create_open_consultation(session_factory)
    await make_user(session_factory, 1, "Аня", status=R)
    await make_user(session_factory, 2, "Маша", status=P)
    await make_user(session_factory, 3, "Ксюша", status=P)

    async with session_factory() as session:
        await signup_user(session, consultation_id, 1)
    async with session_factory() as session:
        await signup_user(session, consultation_id, 2)
    async with session_factory() as session:
        await signup_user(session, consultation_id, 3)

    async with session_factory() as session:
        entries = await get_queue_view(session, consultation_id)

    by_pos = {e.position: e for e in entries}
    assert by_pos[1].display_name == "Маша"
    assert by_pos[2].display_name == "Ксюша"
    assert by_pos[3].is_placeholder and by_pos[3].display_name == "Свободно"
    assert by_pos[4].is_placeholder
    assert by_pos[5].is_placeholder
    assert by_pos[6].display_name == "Аня"

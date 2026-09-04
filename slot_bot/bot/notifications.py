"""
Sending messages out to students.

Every send is wrapped so that one person's blocked bot / deleted account /
transient Telegram hiccup can never interrupt delivery to everyone else --
each failure is logged and skipped, never raised.
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from telegram import Bot
from telegram.error import Forbidden, TelegramError

from ..config import MOSCOW_TZ
from ..models import Consultation
from ..services.users import all_reachable_users, mark_blocked
from . import keyboards, texts

logger = logging.getLogger(__name__)

# Small delay between sends to stay comfortably under Telegram's rate
# limits for a course-sized audience (tens of students, not thousands).
_SEND_DELAY_SECONDS = 0.05


async def _safe_send(bot: Bot, session_factory, user_id: int, **kwargs) -> None:
    try:
        await bot.send_message(chat_id=user_id, **kwargs)
    except Forbidden:
        logger.info("user %s has blocked the bot or deleted their account; marking blocked", user_id)
        async with session_factory() as session:
            await mark_blocked(session, user_id, True)
    except TelegramError as exc:
        logger.warning("failed to send message to user %s: %s", user_id, exc)


async def broadcast_opening(
    bot: Bot, session_factory: async_sessionmaker[AsyncSession], consultation: Consultation
) -> None:
    async with session_factory() as session:
        users = await all_reachable_users(session)

    class_time_str = consultation.scheduled_at.astimezone(MOSCOW_TZ).strftime("%H:%M")
    text = texts.opening_broadcast(class_time_str)
    keyboard = keyboards.signup_inline_keyboard(consultation.id)

    for user in users:
        await _safe_send(bot, session_factory, user.telegram_user_id, text=text, reply_markup=keyboard)
        await asyncio.sleep(_SEND_DELAY_SECONDS)


async def notify_position_changes(
    bot: Bot, session_factory: async_sessionmaker[AsyncSession], changed_positions: dict[int, int]
) -> None:
    for user_id, new_position in changed_positions.items():
        await _safe_send(
            bot, session_factory, user_id, text=texts.position_changed(new_position)
        )
        await asyncio.sleep(_SEND_DELAY_SECONDS)

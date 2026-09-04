"""Handlers for the four queue-related main-menu buttons plus the inline
"Записаться" button attached to the opening broadcast."""
from __future__ import annotations

import re

from telegram import Message, Update
from telegram.ext import CallbackQueryHandler, ContextTypes, MessageHandler, filters

from .. import exceptions
from ..models import PriorityStatus
from ..services import queue as queue_service
from ..services.users import get_user
from . import texts
from .context_helpers import session_factory
from .notifications import notify_position_changes


async def _require_registered(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    session_fac = session_factory(context)
    async with session_fac() as session:
        user = await get_user(session, update.effective_user.id)
    if user is None:
        await update.effective_message.reply_text(texts.NOT_REGISTERED)
        return False
    return True


async def _do_signup(update: Update, context: ContextTypes.DEFAULT_TYPE, consultation_id: int, reply_to: Message) -> None:
    session_fac = session_factory(context)
    user_id = update.effective_user.id
    try:
        async with session_fac() as session:
            result = await queue_service.signup_user(session, consultation_id, user_id)
    except exceptions.RegistrationNotOpenYetError:
        await reply_to.reply_text(texts.REGISTRATION_NOT_OPEN)
        return
    except exceptions.ConsultationNotOpenError:
        await reply_to.reply_text(texts.NO_CURRENT_CONSULTATION)
        return
    except exceptions.UserNotRegisteredError:
        await reply_to.reply_text(texts.NOT_REGISTERED)
        return

    if result.already_signed_up:
        await reply_to.reply_text(texts.ALREADY_SIGNED_UP_HEADER.format(position=result.position))
        return

    message = texts.signed_up_success(result.position)
    if result.status_at_signup == PriorityStatus.RESTRICTED.value:
        message += texts.RESTRICTED_NOTICE
    await reply_to.reply_text(message)


async def on_signup_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_registered(update, context):
        return
    session_fac = session_factory(context)
    async with session_fac() as session:
        consultation = await queue_service.get_current_consultation(session)
    if consultation is None:
        await update.message.reply_text(texts.REGISTRATION_NOT_OPEN)
        return
    await _do_signup(update, context, consultation.id, update.message)


async def on_signup_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    if not await _require_registered(update, context):
        return
    consultation_id = int(query.data.split(":", 1)[1])
    session_fac = session_factory(context)
    async with session_fac() as session:
        current = await queue_service.get_current_consultation(session)
    if current is None or current.id != consultation_id:
        await query.message.reply_text(texts.NO_CURRENT_CONSULTATION)
        return
    await _do_signup(update, context, consultation_id, query.message)


async def on_my_place(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_registered(update, context):
        return
    session_fac = session_factory(context)
    async with session_fac() as session:
        consultation = await queue_service.get_current_consultation(session)
        if consultation is None:
            await update.message.reply_text(texts.MY_PLACE_NOT_SIGNED_UP)
            return
        result = await queue_service.get_my_position(session, consultation.id, update.effective_user.id)
    if not result.signed_up:
        await update.message.reply_text(texts.MY_PLACE_NOT_SIGNED_UP)
    else:
        await update.message.reply_text(texts.MY_PLACE_SIGNED_UP.format(position=result.position))


async def on_view_queue(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_registered(update, context):
        return
    session_fac = session_factory(context)
    async with session_fac() as session:
        consultation = await queue_service.get_current_consultation(session)
        if consultation is None:
            await update.message.reply_text(texts.NO_CURRENT_CONSULTATION)
            return
        entries = await queue_service.get_queue_view(session, consultation.id)
    if not entries:
        await update.message.reply_text(texts.QUEUE_HEADER + texts.QUEUE_EMPTY)
        return
    lines = [texts.QUEUE_HEADER.rstrip()]
    lines.extend(f"{e.position}. {e.display_name}" for e in entries)
    await update.message.reply_text("\n".join(lines))


async def on_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not await _require_registered(update, context):
        return
    session_fac = session_factory(context)
    async with session_fac() as session:
        consultation = await queue_service.get_current_consultation(session)
        if consultation is None:
            await update.message.reply_text(texts.CANCEL_NOTHING_TO_CANCEL)
            return
        result = await queue_service.cancel_signup(session, consultation.id, update.effective_user.id)
    if not result.had_active_signup:
        await update.message.reply_text(texts.CANCEL_NOTHING_TO_CANCEL)
        return
    await update.message.reply_text(texts.CANCEL_DONE)
    if result.changed_positions:
        await notify_position_changes(context.bot, session_fac, result.changed_positions)


signup_button_handler = MessageHandler(filters.Regex(f"^{re.escape(texts.BTN_SIGNUP)}$"), on_signup_button)
signup_callback_handler = CallbackQueryHandler(on_signup_callback, pattern=r"^signup:\d+$")
my_place_handler = MessageHandler(filters.Regex(f"^{re.escape(texts.BTN_MY_PLACE)}$"), on_my_place)
queue_view_handler = MessageHandler(filters.Regex(f"^{re.escape(texts.BTN_QUEUE)}$"), on_view_queue)
cancel_handler = MessageHandler(filters.Regex(f"^{re.escape(texts.BTN_CANCEL)}$"), on_cancel)

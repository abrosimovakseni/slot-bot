"""Global error handler: logs everything, and if ADMIN_ID is configured,
also pings the admin so a broken deployment doesn't fail silently."""
from __future__ import annotations

import html
import logging
import traceback

from telegram.ext import ContextTypes

from ..config import ADMIN_ID

logger = logging.getLogger(__name__)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("Unhandled exception while processing update", exc_info=context.error)

    if ADMIN_ID is None:
        return

    tb_list = traceback.format_exception(None, context.error, context.error.__traceback__)
    tb_string = "".join(tb_list)[-3000:]
    text = (
        "⚠️ SLOT bot error\n"
        f"<pre>{html.escape(tb_string)}</pre>"
    )
    try:
        await context.bot.send_message(chat_id=ADMIN_ID, text=text, parse_mode="HTML")
    except Exception:
        logger.exception("failed to notify admin about error")

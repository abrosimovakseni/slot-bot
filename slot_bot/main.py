"""Entry point: `python -m slot_bot.main`.

Loads configuration, makes sure the database schema exists, builds the
Telegram application, and starts polling. This is the single process
Railway (or your own machine) needs to run.
"""
from __future__ import annotations

import logging
import sys
import warnings

from telegram.warnings import PTBUserWarning

# We deliberately mix MessageHandler and CallbackQueryHandler across
# ConversationHandler states (e.g. type a name, then tap a button) -- this
# is a supported, correct usage; PTB's generic per_message warning about it
# is a known false positive for this pattern. Must run BEFORE importing
# .bot.app, since the ConversationHandlers (and thus the warning) are
# constructed at module-import time.
warnings.filterwarnings("ignore", category=PTBUserWarning, message=r".*per_message.*")

from telegram import Update  # noqa: E402

from .bot.app import build_application  # noqa: E402
from .config import BOT_TOKEN, DATABASE_URL  # noqa: E402
from .db import make_engine, make_session_factory  # noqa: E402

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    level=logging.INFO,
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


def _check_env() -> None:
    missing = []
    if not BOT_TOKEN:
        missing.append("BOT_TOKEN")
    if not DATABASE_URL:
        missing.append("DATABASE_URL")
    if missing:
        logger.error(
            "Missing required environment variable(s): %s. "
            "Set them (see .env.example) before starting the bot.",
            ", ".join(missing),
        )
        sys.exit(1)


def main() -> None:
    _check_env()

    # Building the engine/session factory is synchronous (it doesn't open
    # a connection yet, just configures the pool), so this is safe to do
    # before run_polling() takes ownership of the event loop. The actual
    # async schema setup happens in bot/app.py's post_init hook, inside
    # the loop run_polling() manages -- see the comment there for why.
    engine = make_engine(DATABASE_URL)
    session_factory = make_session_factory(engine)

    application = build_application(BOT_TOKEN, session_factory, engine)
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()

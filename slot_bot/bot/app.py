"""Builds the PTB Application: registers all handlers and schedules the
recurring jobs that open/finalize consultations.

Scheduling strategy (see services/consultations.py for the full rationale):
  * One `run_daily` job per weekly schedule entry, firing exactly at its
    registration-opening time, for a prompt notification.
  * One `run_repeating` safety-net job (every RECONCILE_INTERVAL_SECONDS)
    that re-derives everything from the database -- this is what makes the
    bot recover automatically from any downtime, missed wakeup, or crash.
  * `post_init` runs the same reconciliation once immediately at startup,
    before the bot starts polling, so state is correct from the first
    moment after a deploy/restart.
"""
from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from telegram import Bot
from telegram.ext import Application, ApplicationBuilder, ContextTypes

from ..config import MOSCOW_TZ, RECONCILE_INTERVAL_SECONDS, WEEKLY_SCHEDULE
from ..db import init_models
from ..models import Consultation
from ..services.consultations import reconcile
from . import handlers_profile, handlers_queue, handlers_start
from .error_handler import on_error
from .notifications import broadcast_opening

logger = logging.getLogger(__name__)


async def reconcile_and_notify(bot: Bot, session_factory: async_sessionmaker[AsyncSession]) -> None:
    try:
        report = await reconcile(session_factory)
    except Exception:
        logger.exception("reconcile() failed")
        raise

    for entry in report.opened:
        if not entry.just_opened:
            continue
        async with session_factory() as session:
            consultation = await session.get(Consultation, entry.consultation_id)
        if consultation is not None:
            logger.info("broadcasting consultation opening for consultation %s", consultation.id)
            await broadcast_opening(bot, session_factory, consultation)

    for result in report.finalized:
        logger.info("finalized a consultation, toggled %d users", len(result.toggled_user_ids))


async def _reconcile_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    session_factory = context.application.bot_data["session_factory"]
    await reconcile_and_notify(context.bot, session_factory)


async def _post_init(application: Application) -> None:
    # Runs inside the event loop that run_polling() itself manages -- this
    # is deliberately the *only* place async DB setup happens. Calling
    # asyncio.run() beforehand (e.g. in main.py) and THEN calling
    # run_polling() breaks PTB on Python 3.11+ (run_polling expects to
    # manage the loop lifecycle itself), so schema creation has to happen
    # here instead of before build_application() is even called.
    engine = application.bot_data["engine"]
    logger.info("ensuring database schema exists")
    await init_models(engine)

    session_factory = application.bot_data["session_factory"]
    logger.info("running startup reconciliation")
    await reconcile_and_notify(application.bot, session_factory)


async def _post_shutdown(application: Application) -> None:
    engine: AsyncEngine = application.bot_data["engine"]
    await engine.dispose()


def build_application(
    token: str, session_factory: async_sessionmaker[AsyncSession], engine: AsyncEngine
) -> Application:
    application = (
        ApplicationBuilder()
        .token(token)
        .post_init(_post_init)
        .post_shutdown(_post_shutdown)
        .build()
    )
    application.bot_data["session_factory"] = session_factory
    application.bot_data["engine"] = engine

    # --- handlers ---------------------------------------------------
    application.add_handler(handlers_start.registration_conversation)
    application.add_handler(handlers_profile.edit_name_conversation)
    application.add_handler(handlers_profile.profile_handler)
    application.add_handler(handlers_queue.signup_button_handler)
    application.add_handler(handlers_queue.signup_callback_handler)
    application.add_handler(handlers_queue.my_place_handler)
    application.add_handler(handlers_queue.queue_view_handler)
    application.add_handler(handlers_queue.cancel_handler)
    application.add_error_handler(on_error)

    # --- scheduled jobs -----------------------------------------------
    # NOTE: telegram.ext.JobQueue.run_daily's `days` uses PTB's own
    # convention (0=Sunday .. 6=Saturday, since PTB v20), which is NOT the
    # same as Python's date.weekday()/ScheduleEntry.weekday (0=Monday ..
    # 6=Sunday) used everywhere else in this codebase. Converting here
    # keeps config.py in the intuitive Python convention while still
    # firing on the right day. If this mapping were ever wrong, it would
    # only delay the opening broadcast by up to RECONCILE_INTERVAL_SECONDS
    # (the safety-net job below re-derives everything from the database
    # independently of PTB's day numbering) -- never cause a wrong or
    # duplicate consultation.
    for entry in WEEKLY_SCHEDULE:
        ptb_weekday = (entry.weekday + 1) % 7
        application.job_queue.run_daily(
            _reconcile_job,
            time=entry.opens_time.replace(tzinfo=MOSCOW_TZ),
            days=(ptb_weekday,),
            name=f"open_{entry.name}",
        )

    application.job_queue.run_repeating(
        _reconcile_job,
        interval=RECONCILE_INTERVAL_SECONDS,
        first=RECONCILE_INTERVAL_SECONDS,
        name="reconcile_safety_net",
    )

    return application

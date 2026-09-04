"""
SQLAlchemy 2.0 ORM models for the SLOT bot.

Design notes (why the schema looks the way it does):

* ``users.telegram_user_id`` is the primary key everywhere. Display names are
  never used to identify a person -- two students can share a name, only the
  Telegram id is trusted.

* ``signups.id`` is a normal auto-incrementing PostgreSQL identity column.
  Postgres assigns identity values atomically and strictly in insertion
  order even under heavy concurrency, so ``id`` doubles as the "who clicked
  first" ordering key -- no extra sequence/column is needed for that.

* A partial unique index guarantees at the database level that a user can
  have at most one *active* signup per consultation. This is a backstop:
  the application also serializes signup/cancel per consultation with a row
  lock (see services/queue.py), but the constraint means that even a bug in
  the application code could never produce a duplicate active signup.

* Nothing about "current position in the queue" is stored. Position is
  always computed on demand from ``status_at_signup`` + insertion order
  (see services/queue.py:compute_positions). This avoids an entire class of
  bugs where a stored position could drift from reality.

* ``consultations.opened_notified_at`` and ``consultations.finalized_at``
  are the idempotency guards described in the spec: both are set with an
  atomic ``UPDATE ... WHERE column IS NULL RETURNING id`` "claim" so the
  opening broadcast and the end-of-consultation status toggle can never
  happen twice, even across restarts or overlapping scheduler ticks.
"""
from __future__ import annotations

import datetime
import enum

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class PriorityStatus(str, enum.Enum):
    PRIORITY = "PRIORITY"
    RESTRICTED = "RESTRICTED"


class User(Base):
    __tablename__ = "users"

    telegram_user_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    username: Mapped[str | None] = mapped_column(String(255), nullable=True)
    registered_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    priority_status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=PriorityStatus.PRIORITY.value
    )
    # Set to true once a send to this user fails with "bot blocked" / "user
    # deleted account". Lets broadcasts skip known-dead chats without
    # affecting anyone else's delivery.
    blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))

    __table_args__ = (
        CheckConstraint(
            "priority_status in ('PRIORITY','RESTRICTED')", name="ck_users_priority_status"
        ),
    )


class Consultation(Base):
    __tablename__ = "consultations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    # Human label such as "Среда" -- purely informational, never used for logic.
    label: Mapped[str] = mapped_column(String(50), nullable=False, server_default="")
    scheduled_at: Mapped[datetime.datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    registration_opens_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    # Idempotency guard for the "signup is open" broadcast.
    opened_notified_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Idempotency guard for the end-of-consultation status toggle + archival.
    finalized_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        UniqueConstraint("scheduled_at", name="uq_consultations_scheduled_at"),
    )


class Signup(Base):
    __tablename__ = "signups"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    consultation_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("consultations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.telegram_user_id", ondelete="CASCADE"), nullable=False
    )
    # Snapshot of the user's PRIORITY/RESTRICTED status at the moment they
    # signed up. This is what the queue algorithm uses -- never the user's
    # "live" status -- so a signup's eligibility for slots 1-5 can never
    # retroactively change.
    status_at_signup: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    cancelled_at: Mapped[datetime.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # True once this signup has been accounted for in a finalize pass
    # (i.e. contributed to the user's PRIORITY/RESTRICTED toggle).
    counted_for_status: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )

    __table_args__ = (
        CheckConstraint(
            "status_at_signup in ('PRIORITY','RESTRICTED')", name="ck_signups_status_at_signup"
        ),
        Index("ix_signups_consultation_active_id", "consultation_id", "active", "id"),
        Index(
            "uq_signups_one_active_per_user_per_consultation",
            "consultation_id",
            "user_id",
            unique=True,
            postgresql_where=text("active"),
        ),
    )

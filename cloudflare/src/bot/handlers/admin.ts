/**
 * Admin-only flow: create or cancel a one-off consultation, for a date/time
 * outside the regular Wed/Fri schedule (an extra session, a makeup slot,
 * and so on). Visible only to `env.ADMIN_ID` (the curator's own
 * telegram_user_id, set as a Cloudflare secret) -- every entry point here
 * re-checks `isAdmin()` itself, never trusting the caller, since the menu
 * button that leads here is also just a label anyone could in principle
 * type.
 *
 * Creating a one-off consultation reuses `ensureCreatedAndOpened()` --
 * exactly the same idempotent create-and-open path the Wed/Fri cron uses,
 * just invoked manually instead of from `scheduled()` -- with registration
 * opened immediately (there's no "wait until 09:30" concept for an ad-hoc
 * slot the curator is adding right now). Cancelling reuses
 * `deleteConsultation()` (db/consultations.ts) and the same Queues-backed
 * notification path as everything else in notify.ts, so a cancellation
 * broadcast to a large group is just as safe against the Workers
 * subrequest limit as the opening broadcast is.
 */
import { getConsultation, deleteConsultation, ensureCreatedAndOpened, listUpcomingConsultations } from "../../db/consultations";
import { clearState, getState, setState } from "../../db/state";
import { enqueueConsultationCancelled, enqueueOpeningBroadcast } from "../../notify";
import {
  adminMenuKeyboard,
  cancelAddConsultationKeyboard,
  cancelConsultationListKeyboard,
  confirmCancelConsultationKeyboard,
  confirmCreateConsultationKeyboard,
  TelegramClient,
} from "../../telegram";
import { formatMoscowDateTime, parseMoscowDateTime } from "../../timeUtils";
import type { Env } from "../../types";
import * as texts from "../texts";

export function isAdmin(env: Env, telegramUserId: number): boolean {
  if (env.ADMIN_ID === undefined || env.ADMIN_ID === "") return false;
  return Number(env.ADMIN_ID) === telegramUserId;
}

export async function showAdminMenu(env: Env, telegram: TelegramClient, chatId: number): Promise<void> {
  await telegram.sendMessage(chatId, texts.ADMIN_MENU_PROMPT, { replyMarkup: adminMenuKeyboard() });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function startAddConsultation(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
): Promise<void> {
  await setState(env, telegramUserId, "admin_add", "ASK_DATETIME", null);
  await telegram.sendMessage(chatId, texts.ASK_CONSULTATION_DATETIME, { replyMarkup: cancelAddConsultationKeyboard() });
}

export async function receiveConsultationDateTime(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  rawText: string,
): Promise<void> {
  const parsed = parseMoscowDateTime(rawText);
  if (parsed === null) {
    await telegram.sendMessage(chatId, texts.INVALID_DATETIME, { replyMarkup: cancelAddConsultationKeyboard() });
    return;
  }
  if (parsed.getTime() <= Date.now()) {
    await telegram.sendMessage(chatId, texts.DATETIME_IN_PAST, { replyMarkup: cancelAddConsultationKeyboard() });
    return;
  }
  // Reuse pending_name as a generic pending-value slot (it's just TEXT, and
  // every flow that needs one clears it before the next one starts) --
  // storing the ISO instant here, not free-text, so it round-trips exactly.
  await setState(env, telegramUserId, "admin_add", "CONFIRM_DATETIME", parsed.toISOString());
  await telegram.sendMessage(chatId, texts.confirmCreateConsultation(formatMoscowDateTime(parsed)), {
    replyMarkup: confirmCreateConsultationKeyboard(),
  });
}

export async function confirmCreateConsultationYes(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (state === null || state.flow !== "admin_add" || state.pending_name === null) {
    await telegram.editMessageText(chatId, messageId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  const scheduledAt = new Date(state.pending_name);
  await clearState(env, telegramUserId);

  const label = formatMoscowDateTime(scheduledAt);
  const result = await ensureCreatedAndOpened(env, label, scheduledAt, new Date());
  await telegram.editMessageText(chatId, messageId, texts.consultationCreated(label));

  if (result.justOpened) {
    const consultation = await getConsultation(env, result.consultationId);
    if (consultation !== null) {
      await enqueueOpeningBroadcast(env, consultation);
    }
  }
}

/** The "◀️ Отмена" button attached to the date/time prompt itself -- lets
 * the admin back out before typing anything, or after a failed retry,
 * without having to type a throwaway value first. */
export async function abortAddConsultation(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  await clearState(env, telegramUserId);
  await telegram.editMessageText(chatId, messageId, texts.ADMIN_CANCEL_ABORTED);
}

export async function confirmCreateConsultationNo(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  await clearState(env, telegramUserId);
  await telegram.editMessageText(chatId, messageId, texts.ADMIN_CANCEL_ABORTED);
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------
export async function showCancelList(env: Env, telegram: TelegramClient, chatId: number): Promise<void> {
  const upcoming = await listUpcomingConsultations(env);
  if (upcoming.length === 0) {
    await telegram.sendMessage(chatId, texts.NO_UPCOMING_CONSULTATIONS);
    return;
  }
  const items = upcoming.map((c) => ({ id: c.id, label: formatMoscowDateTime(new Date(c.scheduled_at)) }));
  await telegram.sendMessage(chatId, texts.CHOOSE_CONSULTATION_TO_CANCEL, {
    replyMarkup: cancelConsultationListKeyboard(items),
  });
}

export async function confirmCancelPick(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
  consultationId: number,
): Promise<void> {
  const consultation = await getConsultation(env, consultationId);
  if (consultation === null || consultation.finalized_at !== null) {
    await telegram.editMessageText(chatId, messageId, texts.NO_UPCOMING_CONSULTATIONS);
    return;
  }
  const label = formatMoscowDateTime(new Date(consultation.scheduled_at));
  await telegram.editMessageText(chatId, messageId, texts.confirmCancelConsultation(label), {
    replyMarkup: confirmCancelConsultationKeyboard(consultationId),
  });
}

export async function executeCancelConsultation(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
  consultationId: number,
): Promise<void> {
  const consultation = await getConsultation(env, consultationId);
  const label = consultation !== null ? formatMoscowDateTime(new Date(consultation.scheduled_at)) : "";

  const result = await deleteConsultation(env, consultationId);
  if (!result.existed) {
    await telegram.editMessageText(chatId, messageId, texts.NO_UPCOMING_CONSULTATIONS);
    return;
  }
  await telegram.editMessageText(chatId, messageId, texts.consultationCancelledAdminConfirm(label));
  if (result.affectedUserIds.length > 0) {
    await enqueueConsultationCancelled(env, consultationId, result.affectedUserIds, label);
  }
}

export async function abortCancelConsultation(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
): Promise<void> {
  await telegram.editMessageText(chatId, messageId, texts.ADMIN_CANCEL_ABORTED);
}

/**
 * Admin-only flows: create or cancel a one-off consultation (for a
 * date/time outside the regular Wed/Fri schedule -- an extra session, a
 * makeup slot, and so on), and change the curator/room of an already
 * existing consultation. Visible only to `env.ADMIN_ID` (the curator's own
 * telegram_user_id, set as a Cloudflare secret) -- every entry point here
 * re-checks `isAdmin()` itself, never trusting the caller, since the menu
 * button that leads here is also just a label anyone could in principle
 * type.
 *
 * Creating a one-off consultation opens registration one hour before its
 * class time, exactly like the regular Wed/Fri schedule -- the row is
 * created right away (createConsultationIfAbsent), but the actual "claim +
 * broadcast" open only happens once that hour-before mark arrives
 * (openDueConsultations), whether that's immediately (if the curator picks
 * a time less than an hour out) or later, picked up by the same 15-minute
 * safety-net cron tick that opens the regular schedule (see
 * db/consultations.ts's reconcile()). Cancelling reuses
 * `deleteConsultation()` (db/consultations.ts) and the same Queues-backed
 * notification path as everything else in notify.ts, so a cancellation
 * broadcast to a large group is just as safe against the Workers
 * subrequest limit as the opening broadcast is.
 *
 * Creating a consultation also asks for its curator and room, defaulting
 * to config.DEFAULT_CURATOR/DEFAULT_ROOM via the "Как обычно" shortcut --
 * see the CURATOR_ROOM_CHOICE / ASK_CURATOR / ASK_ROOM states below. A
 * separate "✏️ Изменить кабинет/куратора" flow (same ASK_CURATOR/ASK_ROOM
 * states, but under the "admin_edit_details" flow) changes those two
 * fields on any already-existing upcoming consultation, notifying anyone
 * already signed up.
 */
import { ADMIN_CONSULTATION_LEAD_MS, DEFAULT_CURATOR, DEFAULT_ROOM } from "../../config";
import {
  activeSignupUserIds,
  createConsultationIfAbsent,
  deleteConsultation,
  getConsultation,
  listUpcomingConsultations,
  openDueConsultations,
  updateConsultationDetails,
} from "../../db/consultations";
import { clearState, getState, setState } from "../../db/state";
import {
  enqueueConsultationCancelled,
  enqueueDetailsChanged,
  enqueueOpeningBroadcast,
  enqueueQueueRefresh,
} from "../../notify";
import {
  adminMenuKeyboard,
  cancelAddConsultationKeyboard,
  cancelConsultationListKeyboard,
  confirmCancelConsultationKeyboard,
  confirmCreateConsultationKeyboard,
  confirmEditDetailsKeyboard,
  curatorRoomChoiceKeyboard,
  editDetailsListKeyboard,
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
  await setState(env, telegramUserId, "admin_add", "CURATOR_ROOM_CHOICE", parsed.toISOString());
  await telegram.sendMessage(chatId, texts.curatorRoomChoicePrompt(DEFAULT_CURATOR, DEFAULT_ROOM), {
    replyMarkup: curatorRoomChoiceKeyboard(),
  });
}

/** "Как обычно" -- accepts the default curator/room without typing anything. */
export async function chooseDefaultCuratorRoom(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (
    state === null ||
    state.flow !== "admin_add" ||
    state.state !== "CURATOR_ROOM_CHOICE" ||
    state.pending_name === null
  ) {
    await telegram.editMessageText(chatId, messageId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  const scheduledAt = new Date(state.pending_name);
  const pendingExtra = JSON.stringify({ curator: DEFAULT_CURATOR, room: DEFAULT_ROOM });
  await setState(env, telegramUserId, "admin_add", "CONFIRM_DATETIME", state.pending_name, pendingExtra);
  await telegram.editMessageText(
    chatId,
    messageId,
    texts.confirmCreateConsultation(formatMoscowDateTime(scheduledAt), DEFAULT_CURATOR, DEFAULT_ROOM),
    { replyMarkup: confirmCreateConsultationKeyboard() },
  );
}

/** "Указать другое" -- the curator will type a one-off curator/room next. */
export async function chooseCustomCuratorRoom(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (
    state === null ||
    state.flow !== "admin_add" ||
    state.state !== "CURATOR_ROOM_CHOICE" ||
    state.pending_name === null
  ) {
    await telegram.editMessageText(chatId, messageId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  await setState(env, telegramUserId, "admin_add", "ASK_CURATOR", state.pending_name);
  await telegram.editMessageText(chatId, messageId, texts.ASK_CURATOR_NAME);
}

export async function receiveCuratorName(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  rawText: string,
): Promise<void> {
  const curator = rawText.trim();
  if (curator === "") {
    await telegram.sendMessage(chatId, texts.INVALID_CURATOR_NAME);
    return;
  }
  const state = await getState(env, telegramUserId);
  if (state === null || state.pending_name === null) {
    await telegram.sendMessage(chatId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  await setState(env, telegramUserId, "admin_add", "ASK_ROOM", state.pending_name, JSON.stringify({ curator }));
  await telegram.sendMessage(chatId, texts.ASK_ROOM);
}

export async function receiveRoom(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  rawText: string,
): Promise<void> {
  const room = rawText.trim();
  if (room === "") {
    await telegram.sendMessage(chatId, texts.INVALID_ROOM);
    return;
  }
  const state = await getState(env, telegramUserId);
  if (state === null || state.pending_name === null) {
    await telegram.sendMessage(chatId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  const extra = state.pending_extra !== null ? (JSON.parse(state.pending_extra) as { curator?: string }) : {};
  const curator = extra.curator ?? DEFAULT_CURATOR;
  const scheduledAt = new Date(state.pending_name);
  await setState(
    env,
    telegramUserId,
    "admin_add",
    "CONFIRM_DATETIME",
    state.pending_name,
    JSON.stringify({ curator, room }),
  );
  await telegram.sendMessage(chatId, texts.confirmCreateConsultation(formatMoscowDateTime(scheduledAt), curator, room), {
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
  const extra =
    state.pending_extra !== null ? (JSON.parse(state.pending_extra) as { curator?: string; room?: string }) : {};
  const curator = extra.curator ?? DEFAULT_CURATOR;
  const room = extra.room ?? DEFAULT_ROOM;
  await clearState(env, telegramUserId);

  const label = formatMoscowDateTime(scheduledAt);
  const opensAt = new Date(scheduledAt.getTime() - ADMIN_CONSULTATION_LEAD_MS);
  const { consultationId } = await createConsultationIfAbsent(env, label, scheduledAt, opensAt, curator, room);

  // If the hour-before mark has already arrived (the curator picked a time
  // less than an hour out), open it right now instead of waiting for the
  // next 15-minute safety-net tick.
  const opened = await openDueConsultations(env, new Date());
  const justOpened = opened.some((o) => o.consultationId === consultationId);
  await telegram.editMessageText(
    chatId,
    messageId,
    texts.consultationCreated(label, justOpened ? null : formatMoscowDateTime(opensAt)),
  );

  if (justOpened) {
    const consultation = await getConsultation(env, consultationId);
    if (consultation !== null) {
      await enqueueOpeningBroadcast(env, consultation);
    }
    // A new consultation just became "current" -- anyone with a pinned
    // queue message should see it reset to this (empty-so-far) queue
    // rather than keep showing the previous, now-irrelevant one.
    await enqueueQueueRefresh(env);
  }
}

/** The "◀️ Отмена" button attached to the date/time prompt itself -- lets
 * the admin back out before typing anything, or after a failed retry,
 * without having to type a throwaway value first. Also reused as the
 * catch-all abort for every later create-flow step (curator/room choice,
 * ASK_CURATOR, ASK_ROOM), since it just clears whatever's pending. */
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
  // The consultation this was is gone -- anyone with a pinned queue
  // message should stop showing it (falling back to "нет открытой записи"
  // or whatever consultation is current now).
  await enqueueQueueRefresh(env);
}

export async function abortCancelConsultation(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
): Promise<void> {
  await telegram.editMessageText(chatId, messageId, texts.ADMIN_CANCEL_ABORTED);
}

// ---------------------------------------------------------------------------
// Edit curator/room for an existing consultation
// ---------------------------------------------------------------------------
export async function startEditDetails(env: Env, telegram: TelegramClient, chatId: number): Promise<void> {
  const upcoming = await listUpcomingConsultations(env);
  if (upcoming.length === 0) {
    await telegram.sendMessage(chatId, texts.NO_UPCOMING_CONSULTATIONS);
    return;
  }
  const items = upcoming.map((c) => ({ id: c.id, label: formatMoscowDateTime(new Date(c.scheduled_at)) }));
  await telegram.sendMessage(chatId, texts.CHOOSE_CONSULTATION_TO_EDIT, {
    replyMarkup: editDetailsListKeyboard(items),
  });
}

export async function pickForEdit(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
  consultationId: number,
): Promise<void> {
  const consultation = await getConsultation(env, consultationId);
  if (consultation === null || consultation.finalized_at !== null) {
    await telegram.editMessageText(chatId, messageId, texts.NO_UPCOMING_CONSULTATIONS);
    return;
  }
  // pending_name carries the consultation id (as text) through this flow,
  // the same generic-slot trick used for the ISO datetime in admin_add.
  await setState(env, telegramUserId, "admin_edit_details", "ASK_CURATOR", String(consultationId));
  await telegram.editMessageText(chatId, messageId, texts.ASK_CURATOR_NAME);
}

export async function receiveEditCurator(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  rawText: string,
): Promise<void> {
  const curator = rawText.trim();
  if (curator === "") {
    await telegram.sendMessage(chatId, texts.INVALID_CURATOR_NAME);
    return;
  }
  const state = await getState(env, telegramUserId);
  if (state === null || state.pending_name === null) {
    await telegram.sendMessage(chatId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  await setState(
    env,
    telegramUserId,
    "admin_edit_details",
    "ASK_ROOM",
    state.pending_name,
    JSON.stringify({ curator }),
  );
  await telegram.sendMessage(chatId, texts.ASK_ROOM);
}

export async function receiveEditRoom(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  rawText: string,
): Promise<void> {
  const room = rawText.trim();
  if (room === "") {
    await telegram.sendMessage(chatId, texts.INVALID_ROOM);
    return;
  }
  const state = await getState(env, telegramUserId);
  if (state === null || state.pending_name === null) {
    await telegram.sendMessage(chatId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  const extra = state.pending_extra !== null ? (JSON.parse(state.pending_extra) as { curator?: string }) : {};
  const curator = extra.curator ?? "";
  const consultationId = Number(state.pending_name);
  const consultation = await getConsultation(env, consultationId);
  if (consultation === null) {
    await clearState(env, telegramUserId);
    await telegram.sendMessage(chatId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  const label = formatMoscowDateTime(new Date(consultation.scheduled_at));
  await setState(
    env,
    telegramUserId,
    "admin_edit_details",
    "CONFIRM_EDIT_DETAILS",
    state.pending_name,
    JSON.stringify({ curator, room }),
  );
  await telegram.sendMessage(chatId, texts.confirmEditDetails(label, curator, room), {
    replyMarkup: confirmEditDetailsKeyboard(consultationId),
  });
}

export async function confirmEditDetailsYes(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
  consultationId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (
    state === null ||
    state.flow !== "admin_edit_details" ||
    state.pending_name !== String(consultationId) ||
    state.pending_extra === null
  ) {
    await telegram.editMessageText(chatId, messageId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  const { curator, room } = JSON.parse(state.pending_extra) as { curator: string; room: string };
  await clearState(env, telegramUserId);

  const consultation = await getConsultation(env, consultationId);
  if (consultation === null) {
    await telegram.editMessageText(chatId, messageId, texts.ADMIN_ACTION_EXPIRED);
    return;
  }
  const label = formatMoscowDateTime(new Date(consultation.scheduled_at));
  await updateConsultationDetails(env, consultationId, curator, room);
  await telegram.editMessageText(chatId, messageId, texts.detailsUpdated(label));

  const affectedUserIds = await activeSignupUserIds(env, consultationId);
  if (affectedUserIds.length > 0) {
    await enqueueDetailsChanged(env, consultationId, affectedUserIds, label, curator, room);
  }
  await enqueueQueueRefresh(env);
}

export async function confirmEditDetailsNo(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  await clearState(env, telegramUserId);
  await telegram.editMessageText(chatId, messageId, texts.ADMIN_CANCEL_ABORTED);
}

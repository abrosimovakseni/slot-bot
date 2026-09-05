/**
 * Admin-only flows: create or cancel a one-off consultation (for a
 * date/time outside the regular weekly schedule -- an extra session, a
 * makeup slot, and so on), change the curator/room of an already existing
 * consultation, and manage the recurring weekly schedule itself (db/schedule.ts
 * -- add/remove entries like "каждую среду в 10:30", see the "📅
 * Еженедельный график" section near the bottom of this file). Visible only
 * to `env.ADMIN_ID` (the curator's own telegram_user_id, set as a
 * Cloudflare secret) -- every entry point here re-checks `isAdmin()`
 * itself, never trusting the caller, since the menu button that leads here
 * is also just a label anyone could in principle type.
 *
 * Creating a one-off consultation opens registration one hour before its
 * class time, exactly like the regular weekly schedule -- the row is
 * created right away (createConsultationIfAbsent), but the actual "claim +
 * broadcast" open only happens once that hour-before mark arrives, which
 * is either immediate (if the curator picks a time less than an hour out
 * -- openDueConsultations catches it right here) or scheduled precisely
 * via a Durable Object alarm (see ../../consultationOpener.ts) so it opens
 * to the second rather than whenever the once-a-minute safety-net cron
 * tick next happens to land (see db/consultations.ts's reconcile(), which
 * stays as a backup in case that alarm is ever missed). Cancelling reuses
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
import { ADMIN_CONSULTATION_LEAD_MS, DEFAULT_CURATOR, DEFAULT_ROOM, WEEKDAY_NAMES } from "../../config";
import { cancelOpenAlarm, scheduleOpenAlarm } from "../../consultationOpener";
import {
  activeSignupUserIds,
  createConsultationIfAbsent,
  deleteConsultation,
  getConsultation,
  listUpcomingConsultations,
  openDueConsultations,
  updateConsultationDetails,
} from "../../db/consultations";
import { addScheduleEntry, deleteScheduleEntry, getScheduleEntry, listAllScheduleEntries } from "../../db/schedule";
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
  cancelAddScheduleKeyboard,
  cancelConsultationListKeyboard,
  confirmAddScheduleKeyboard,
  confirmCancelConsultationKeyboard,
  confirmCreateConsultationKeyboard,
  confirmDeleteScheduleKeyboard,
  confirmEditDetailsKeyboard,
  curatorRoomChoiceKeyboard,
  editDetailsListKeyboard,
  scheduleCuratorRoomChoiceKeyboard,
  scheduleListKeyboard,
  TelegramClient,
  weekdayPickerKeyboard,
} from "../../telegram";
import { formatMoscowDateTime, formatTimeOfDay, openTimeOneHourBefore, parseMoscowDateTime, parseTimeOfDay } from "../../timeUtils";
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
  // next once-a-minute safety-net tick.
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
  } else {
    // Not due yet -- schedule the exact-time opening alarm (see
    // consultationOpener.ts) instead of leaving this to whenever the next
    // once-a-minute safety-net tick happens to land.
    await scheduleOpenAlarm(env, consultationId, opensAt);
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
  // Harmless no-op for a regular weekly-schedule consultation (which never had an
  // alarm scheduled in the first place) -- only actually cancels anything
  // for an admin one-off whose opening alarm hadn't fired yet.
  await cancelOpenAlarm(env, consultationId);
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

// ---------------------------------------------------------------------------
// Weekly recurring schedule ("📅 Еженедельный график") -- add/remove regular
// weekly consultation slots (e.g. "каждую среду в 10:30") entirely through
// the bot, so a new owner of a duplicated deployment (see db/schedule.ts's
// doc comment) never needs a code change or a developer's help to set up
// their own group's schedule.
//
// Carries its state (weekday, class time, opens time, and optionally a
// custom curator/room) through user_state.pending_extra as one evolving
// JSON object across the flow's steps -- pending_name is unused here.
// ---------------------------------------------------------------------------
interface PendingSchedule {
  weekday: number;
  classHour?: number;
  classMinute?: number;
  opensHour?: number;
  opensMinute?: number;
  curator?: string;
  room?: string;
}

function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? String(weekday);
}

export async function showScheduleMenu(env: Env, telegram: TelegramClient, chatId: number): Promise<void> {
  const all = await listAllScheduleEntries(env);
  if (all.length === 0) {
    await telegram.sendMessage(chatId, texts.SCHEDULE_LIST_EMPTY, { replyMarkup: scheduleListKeyboard([]) });
    return;
  }
  const lines = all.map((e) =>
    texts.scheduleEntryLine(
      weekdayName(e.weekday),
      formatTimeOfDay({ hour: e.class_hour, minute: e.class_minute }),
      e.curator,
      e.room,
    ),
  );
  const items = all.map((e) => ({
    id: e.id,
    label: `${weekdayName(e.weekday)} ${formatTimeOfDay({ hour: e.class_hour, minute: e.class_minute })}`,
  }));
  await telegram.sendMessage(chatId, `${texts.scheduleListHeader()}\n${lines.join("\n")}`, {
    replyMarkup: scheduleListKeyboard(items),
  });
}

export async function startAddSchedule(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
): Promise<void> {
  await setState(env, telegramUserId, "admin_schedule", "ASK_WEEKDAY", null);
  await telegram.sendMessage(chatId, texts.ASK_SCHEDULE_WEEKDAY, { replyMarkup: weekdayPickerKeyboard() });
}

export async function pickScheduleWeekday(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
  weekday: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (state === null || state.flow !== "admin_schedule" || state.state !== "ASK_WEEKDAY") {
    await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const pending: PendingSchedule = { weekday };
  await setState(env, telegramUserId, "admin_schedule", "ASK_CLASS_TIME", null, JSON.stringify(pending));
  await telegram.editMessageText(chatId, messageId, texts.ASK_SCHEDULE_CLASS_TIME);
}

export async function receiveScheduleClassTime(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  rawText: string,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (state === null || state.flow !== "admin_schedule" || state.state !== "ASK_CLASS_TIME" || state.pending_extra === null) {
    await telegram.sendMessage(chatId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const parsed = parseTimeOfDay(rawText);
  if (parsed === null) {
    await telegram.sendMessage(chatId, texts.INVALID_TIME_OF_DAY, { replyMarkup: cancelAddScheduleKeyboard() });
    return;
  }
  const opens = openTimeOneHourBefore(parsed);
  const pending: PendingSchedule = {
    ...(JSON.parse(state.pending_extra) as PendingSchedule),
    classHour: parsed.hour,
    classMinute: parsed.minute,
    opensHour: opens.hour,
    opensMinute: opens.minute,
  };
  await setState(env, telegramUserId, "admin_schedule", "CURATOR_ROOM_CHOICE", null, JSON.stringify(pending));
  await telegram.sendMessage(chatId, texts.scheduleCuratorRoomChoicePrompt(DEFAULT_CURATOR, DEFAULT_ROOM), {
    replyMarkup: scheduleCuratorRoomChoiceKeyboard(),
  });
}

async function showScheduleConfirm(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
  pending: PendingSchedule,
): Promise<void> {
  const classTimeStr = formatTimeOfDay({ hour: pending.classHour!, minute: pending.classMinute! });
  const opensTimeStr = formatTimeOfDay({ hour: pending.opensHour!, minute: pending.opensMinute! });
  const curator = pending.curator ?? DEFAULT_CURATOR;
  const room = pending.room ?? DEFAULT_ROOM;
  await telegram.editMessageText(
    chatId,
    messageId,
    texts.confirmAddSchedule(weekdayName(pending.weekday), classTimeStr, opensTimeStr, curator, room),
    { replyMarkup: confirmAddScheduleKeyboard() },
  );
}

/** "Как обычно" -- accepts the default curator/room without typing anything. */
export async function chooseScheduleDefaultCuratorRoom(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (
    state === null ||
    state.flow !== "admin_schedule" ||
    state.state !== "CURATOR_ROOM_CHOICE" ||
    state.pending_extra === null
  ) {
    await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const pending = JSON.parse(state.pending_extra) as PendingSchedule;
  await setState(env, telegramUserId, "admin_schedule", "CONFIRM_SCHEDULE", null, JSON.stringify(pending));
  await showScheduleConfirm(env, telegram, chatId, messageId, pending);
}

/** "Указать другое" -- the admin will type a custom curator/room next. */
export async function chooseScheduleCustomCuratorRoom(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (
    state === null ||
    state.flow !== "admin_schedule" ||
    state.state !== "CURATOR_ROOM_CHOICE" ||
    state.pending_extra === null
  ) {
    await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  await setState(env, telegramUserId, "admin_schedule", "ASK_CURATOR", null, state.pending_extra);
  await telegram.editMessageText(chatId, messageId, texts.ASK_CURATOR_NAME);
}

export async function receiveScheduleCuratorName(
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
  if (state === null || state.pending_extra === null) {
    await telegram.sendMessage(chatId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const pending: PendingSchedule = { ...(JSON.parse(state.pending_extra) as PendingSchedule), curator };
  await setState(env, telegramUserId, "admin_schedule", "ASK_ROOM", null, JSON.stringify(pending));
  await telegram.sendMessage(chatId, texts.ASK_ROOM);
}

export async function receiveScheduleRoom(
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
  if (state === null || state.pending_extra === null) {
    await telegram.sendMessage(chatId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const pending: PendingSchedule = { ...(JSON.parse(state.pending_extra) as PendingSchedule), room };
  await setState(env, telegramUserId, "admin_schedule", "CONFIRM_SCHEDULE", null, JSON.stringify(pending));
  const classTimeStr = formatTimeOfDay({ hour: pending.classHour!, minute: pending.classMinute! });
  const opensTimeStr = formatTimeOfDay({ hour: pending.opensHour!, minute: pending.opensMinute! });
  await telegram.sendMessage(
    chatId,
    texts.confirmAddSchedule(weekdayName(pending.weekday), classTimeStr, opensTimeStr, pending.curator!, pending.room!),
    { replyMarkup: confirmAddScheduleKeyboard() },
  );
}

export async function confirmAddScheduleYes(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  const state = await getState(env, telegramUserId);
  if (state === null || state.flow !== "admin_schedule" || state.pending_extra === null) {
    await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const pending = JSON.parse(state.pending_extra) as PendingSchedule;
  await clearState(env, telegramUserId);

  await addScheduleEntry(env, {
    name: weekdayName(pending.weekday),
    weekday: pending.weekday,
    classHour: pending.classHour!,
    classMinute: pending.classMinute!,
    opensHour: pending.opensHour!,
    opensMinute: pending.opensMinute!,
    curator: pending.curator,
    room: pending.room,
  });

  const classTimeStr = formatTimeOfDay({ hour: pending.classHour!, minute: pending.classMinute! });
  await telegram.editMessageText(chatId, messageId, texts.scheduleAdded(weekdayName(pending.weekday), classTimeStr));
}

/** Cancel button attached throughout the add flow, and the "Отмена" option
 * on the final confirm step -- both just clear whatever's pending. */
export async function abortAddSchedule(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  telegramUserId: number,
  messageId: number,
): Promise<void> {
  await clearState(env, telegramUserId);
  await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_CANCELLED);
}

export async function pickScheduleDelete(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
  id: number,
): Promise<void> {
  const entry = await getScheduleEntry(env, id);
  if (entry === null) {
    await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const timeStr = formatTimeOfDay({ hour: entry.class_hour, minute: entry.class_minute });
  await telegram.editMessageText(chatId, messageId, texts.confirmDeleteSchedule(weekdayName(entry.weekday), timeStr), {
    replyMarkup: confirmDeleteScheduleKeyboard(id),
  });
}

export async function confirmDeleteScheduleYes(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
  id: number,
): Promise<void> {
  const entry = await getScheduleEntry(env, id);
  if (entry === null) {
    await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  const timeStr = formatTimeOfDay({ hour: entry.class_hour, minute: entry.class_minute });
  const deleted = await deleteScheduleEntry(env, id);
  if (!deleted) {
    await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_ACTION_EXPIRED);
    return;
  }
  await telegram.editMessageText(chatId, messageId, texts.scheduleDeleted(weekdayName(entry.weekday), timeStr));
}

export async function abortDeleteSchedule(
  env: Env,
  telegram: TelegramClient,
  chatId: number,
  messageId: number,
): Promise<void> {
  await telegram.editMessageText(chatId, messageId, texts.SCHEDULE_CANCELLED);
}

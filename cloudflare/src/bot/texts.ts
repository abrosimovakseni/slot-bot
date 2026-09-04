/** All button labels and static message strings -- direct port of the
 * Railway version's bot/texts.py, wording unchanged. */

export const BTN_SIGNUP = "Записаться";
export const BTN_MY_PLACE = "Моё место";
export const BTN_QUEUE = "Посмотреть очередь";
export const BTN_CANCEL = "Отменить запись";
export const BTN_PROFILE = "Мой профиль";

export const WELCOME_NEW = "Привет! Это SLOT.\nЧтобы записываться на консультации, введи имя и фамилию.";
export const WELCOME_BACK = "С возвращением! Выбери действие в меню ниже.";
export const ASK_NAME_AGAIN = "Хорошо, введи имя и фамилию ещё раз.";
export const REGISTRATION_DONE = "Готово! Теперь тебе доступно меню записи на консультации.";
export const INVALID_NAME = "Имя и фамилия не должны быть пустыми. Попробуй ещё раз.";

export function confirmName(name: string): string {
  return `${name}, верно?`;
}

export const NOT_REGISTERED = "Сначала нужно зарегистрироваться. Отправь /start.";
export const REGISTRATION_NOT_OPEN = "Запись ещё не открыта.";
export const ALREADY_SIGNED_UP_HEADER = (position: number) =>
  `Вы уже записаны.\nВаше текущее место: №${position}`;

export function signedUpSuccess(position: number): string {
  return `✅ Вы записаны.\nВаше место: №${position}`;
}

export const RESTRICTED_NOTICE =
  "\n\nНа этой консультации для вас действует очередь 6+.\n" +
  "После этой состоявшейся записи на следующей консультации вам снова будет доступна первая пятёрка.";

export const MY_PLACE_SIGNED_UP = (position: number) => `Ваше текущее место: №${position}`;
export const MY_PLACE_NOT_SIGNED_UP = "Вы пока не записаны на эту консультацию.";

export const CANCEL_DONE = "Запись отменена.";
export const CANCEL_NOTHING_TO_CANCEL = "У вас нет активной записи на эту консультацию.";

export const QUEUE_EMPTY = "Пока никто не записался.";
export const QUEUE_HEADER = "📋 Очередь";

export const NO_CURRENT_CONSULTATION = "Сейчас нет открытой записи на консультацию.";

export function positionChanged(position: number): string {
  return `🔄 Очередь изменилась.\nВаше новое место: №${position}`;
}

export function openingBroadcast(classTimeStr: string): string {
  return `🔔 Открыта запись на консультацию.\nПара начинается в ${classTimeStr}.`;
}

export function profileCard(displayName: string, username: string | null): string {
  const handle = username ? `@${username}` : "username не указан";
  return `👤 ${displayName}\n${handle}`;
}

export const ASK_NEW_NAME = "Введи новое имя и фамилию.";
export const NAME_UPDATED = "Имя обновлено.";

// ---------------------------------------------------------------------------
// Admin: one-off consultations (visible only to env.ADMIN_ID)
// ---------------------------------------------------------------------------
export const BTN_ADMIN = "🛠 Админ";

export const ADMIN_MENU_PROMPT = "Управление консультациями:";

export const ASK_CONSULTATION_DATETIME =
  "Введи дату и время новой консультации в формате ДД.ММ.ГГГГ ЧЧ:ММ (по московскому времени).\n" +
  "Например: 20.09.2026 15:00";

export const INVALID_DATETIME =
  "Не получилось распознать дату и время. Формат: ДД.ММ.ГГГГ ЧЧ:ММ, например 20.09.2026 15:00.";

export const DATETIME_IN_PAST = "Эта дата и время уже в прошлом. Введи другое значение.";

export function confirmCreateConsultation(label: string): string {
  return `Создать консультацию на ${label} (мск)? Запись откроется за час до начала, как обычно.`;
}

/** `opensAtLabel` is null when registration is due right away (the 1-hour
 * mark has already passed by the time the curator confirmed creation) --
 * otherwise it's the "DD.MM.YYYY HH:MM" moment registration will open. */
export function consultationCreated(label: string, opensAtLabel: string | null): string {
  if (opensAtLabel === null) {
    return `✅ Консультация на ${label} создана и уже открыта для записи.`;
  }
  return `✅ Консультация на ${label} создана. Запись откроется ${opensAtLabel} (мск).`;
}

export const NO_UPCOMING_CONSULTATIONS = "Нет предстоящих консультаций.";
export const CHOOSE_CONSULTATION_TO_CANCEL = "Выбери консультацию для отмены:";

export function confirmCancelConsultation(label: string): string {
  return `Точно отменить консультацию ${label}? Все, кто уже записан, будут уведомлены.`;
}

export function consultationCancelledAdminConfirm(label: string): string {
  return `🗑 Консультация ${label} отменена.`;
}

export function consultationCancelled(label: string): string {
  return `❌ Консультация ${label} отменена организатором. Приносим извинения за неудобства.`;
}

export const ADMIN_ACTION_EXPIRED = "Действие устарело, начни заново через меню «🛠 Админ».";
export const ADMIN_CANCEL_ABORTED = "Отменено.";

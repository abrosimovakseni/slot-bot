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

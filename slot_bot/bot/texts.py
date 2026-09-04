"""All button labels and static message strings in one place, so wording
can be tweaked without touching any logic."""

BTN_SIGNUP = "Записаться"
BTN_MY_PLACE = "Моё место"
BTN_QUEUE = "Посмотреть очередь"
BTN_CANCEL = "Отменить запись"
BTN_PROFILE = "Мой профиль"
BTN_EDIT_NAME = "Изменить имя"
BTN_YES = "Да"
BTN_EDIT = "Изменить"

WELCOME_NEW = (
    "Привет! Это SLOT.\n"
    "Чтобы записываться на консультации, введи имя и фамилию."
)

WELCOME_BACK = "С возвращением! Выбери действие в меню ниже."

ASK_NAME_AGAIN = "Хорошо, введи имя и фамилию ещё раз."

REGISTRATION_DONE = "Готово! Теперь тебе доступно меню записи на консультации."

INVALID_NAME = "Имя и фамилия не должны быть пустыми. Попробуй ещё раз."


def confirm_name(name: str) -> str:
    return f"{name}, верно?"


NOT_REGISTERED = "Сначала нужно зарегистрироваться. Отправь /start."

REGISTRATION_NOT_OPEN = "Запись ещё не открыта."

ALREADY_SIGNED_UP_HEADER = "Вы уже записаны.\nВаше текущее место: №{position}"


def signed_up_success(position: int) -> str:
    return f"✅ Вы записаны.\nВаше место: №{position}"


RESTRICTED_NOTICE = (
    "\n\nНа этой консультации для вас действует очередь 6+.\n"
    "После этой состоявшейся записи на следующей консультации вам снова будет доступна первая пятёрка."
)

MY_PLACE_SIGNED_UP = "Ваше текущее место: №{position}"
MY_PLACE_NOT_SIGNED_UP = "Вы пока не записаны на эту консультацию."

CANCEL_DONE = "Запись отменена."
CANCEL_NOTHING_TO_CANCEL = "У вас нет активной записи на эту консультацию."

QUEUE_EMPTY = "Пока никто не записался."
QUEUE_HEADER = "📋 Очередь\n"

NO_CURRENT_CONSULTATION = "Сейчас нет открытой записи на консультацию."


def position_changed(position: int) -> str:
    return f"🔄 Очередь изменилась.\nВаше новое место: №{position}"


def opening_broadcast(class_time_str: str) -> str:
    return f"🔔 Открыта запись на консультацию.\nПара начинается в {class_time_str}."


def profile_card(display_name: str, username: str | None) -> str:
    handle = f"@{username}" if username else "username не указан"
    return f"👤 {display_name}\n{handle}"


ASK_NEW_NAME = "Введи новое имя и фамилию."
NAME_UPDATED = "Имя обновлено."

import type { Dictionary } from "../types";

/** Раздел: бронь подписочного приложения (routes/schedule.tsx), «Клуб» (routes/club.tsx), срок отмены записи (hooks/use-club-settings.ts). */
const dict: Dictionary = {
  "Расписание и запись на занятия {brand}.": "{brand} class schedule and booking.",
  Классы: "Classes",
  Персональные: "Personal",
  Диагностика: "Diagnostics",
  "Не удалось загрузить ваши записи: {error}": "Couldn't load your bookings: {error}",
  "Не удалось отменить запись: {error}": "Couldn't cancel the booking: {error}",
  "Не удалось записаться: {error}": "Couldn't book: {error}",
  "Войдите в аккаунт, чтобы записаться": "Log in to book",
  "Профиль клиента не найден. Обратитесь к администратору.":
    "Client profile not found. Please contact an administrator.",
  "Нет активного абонемента. Купите абонемент, чтобы записаться.":
    "No active membership. Buy a membership to book.",
  "На абонементе закончились посещения": "No visits left on your membership",
  "Тренировка не найдена": "Workout not found",
  "Эта тренировка уже прошла": "This workout has already taken place",
  "Свободных мест больше нет": "No spots left",
  "Вы не были записаны на эту тренировку": "You weren't booked for this workout",
  "Вы вышли из листа ожидания": "You've left the waitlist",
  "Запись отменена": "Booking cancelled",
  "Мест нет — вы в листе ожидания": "Fully booked — you're on the waitlist",
  "Вы записаны на тренировку": "You're booked for the workout",
  "Не удалось выполнить действие: {reason}": "Something went wrong: {reason}",
  Все: "All",
  "Выберите день и забронируйте тренировку": "Pick a day and book a workout",
  "Совсем скоро мы начнем принимать заявки на персональные тренировки":
    "We'll start taking personal training requests very soon",
  "Функционал скоро будет доступен": "Coming soon",
  "Ошибка загрузки: {error}": "Loading error: {error}",
  "На этот день тренировок пока нет": "No workouts on this day yet",
  Занятие: "Class",
  "В листе ожидания": "On the waitlist",
  "Мест нет": "Fully booked",
  "Осталось {n} место|Осталось {n} места|Осталось {n} мест": "{n} spot left|{n} spots left",
  Записаться: "Book",
  Студия: "Studio",
  Клуб: "Club",
  "О студии и её тренерах.": "About the studio and its trainers.",
  "Челленджи, участники и жизнь клуба Base40.": "Challenges, members and life at the Base40 club.",
  "Челленджи, участники и события": "Challenges, members and events",
  "Здесь скоро появится сообщество": "The community is coming soon",
  "Челленджи, рейтинги и другие участники появятся в одном из ближайших обновлений.":
    "Challenges, leaderboards and other members are coming in an upcoming update.",
  "{h}ч {m}мин": "{h} h {m} min",
  "{h}ч": "{h} h",
  "{m}мин": "{m} min",
  "Прошедшие тренировки · {n}": "Past workouts · {n}",
  "Скрыть прошедшие тренировки": "Hide past workouts",
  "На сегодня тренировок больше нет": "No more workouts today",
};

export default dict;

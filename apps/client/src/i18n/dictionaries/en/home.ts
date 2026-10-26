import type { Dictionary } from "../types";

/** Раздел: главная (routes/index.tsx — новости, услуги, ближайшие записи, быстрые кнопки). */
const dict: Dictionary = {
  "Главное — {brand}": "Home — {brand}",
  "Главная страница {brand}: новости, акции и быстрый доступ к профилю.":
    "{brand} home: news, offers and quick access to your profile.",
  Участник: "Member",
  "Пригласи подругу": "Invite a friend",
  Подарки: "Gifts",
  "Уведомления: непрочитанных {n}": "Notifications: {n} unread",
  Уведомления: "Notifications",
  "Не удалось загрузить новости. Обновите страницу.":
    "Couldn't load news. Please refresh the page.",
  "Пока нет новостей": "No news yet",
  Написать: "Message",
  Позвонить: "Call",
  Фидбэк: "Feedback",
  Тренировки: "Workouts",
  "Не удалось загрузить ваши записи. Обновите страницу.":
    "Couldn't load your bookings. Please refresh the page.",
  "У вас нет запланированных тренировок": "You have no upcoming workouts",
  Записаться: "Book",
  Забронировать: "Book",
  Занятие: "Class",
  "Не удалось отменить запись: {error}": "Couldn't cancel booking: {error}",
  "Запись отменена": "Booking cancelled",
  Услуги: "Services",
  "Дополнительные возможности для клиентов студии": "Extras for studio members",
  "Дополнительные возможности для участников клуба": "Extras for club members",
  "Не удалось загрузить услуги. Обновите страницу.":
    "Couldn't load services. Please refresh the page.",
  "Пока нет услуг": "No services yet",
  // История посещений (components/visit-history-drawer.tsx)
  "История посещений": "Visit history",
  "Прошедшие тренировки": "Past workouts",
  Посещено: "Attended",
  Отменено: "Cancelled",
  Пропущено: "Missed",
  "Ожидает отметки": "Not marked yet",
  "Диагностика тела": "Body diagnostics",
  "{n} ккал": "{n} kcal",
  "Не удалось загрузить историю посещений. Попробуйте ещё раз.":
    "Couldn't load your visit history. Please try again.",
  "Здесь появятся тренировки, на которых вы были": "Workouts you've attended will appear here",
};

export default dict;

import type { Dictionary } from "../types";

/**
 * Раздел: пакетное приложение — расписание, карточка тренировки, «Студия»
 * (тренеры, рейтинг, чаевые), абонементы, переключатель студий.
 */
const dict: Dictionary = {
  "Мест нет": "Full",
  "Свободно {n} место|Свободно {n} места|Свободно {n} мест": "{n} spot left|{n} spots left",
  "В листе ожидания": "On the waitlist",
  Тренировки: "Workouts",
  Персональные: "Personal",
  Диагностика: "Assessment",
  "Не удалось загрузить ваши записи: {error}": "Couldn't load your bookings: {error}",
  "Не удалось отменить запись: {error}": "Couldn't cancel the booking: {error}",
  "Не удалось записаться: {error}": "Couldn't book: {error}",
  "Войдите в аккаунт, чтобы записаться": "Log in to book",
  "Профиль клиента не найден. Обратитесь к администратору.":
    "Client profile not found. Please contact the front desk.",
  "Нет действующего абонемента — обратитесь к администратору студии.":
    "No active membership — please contact the studio's front desk.",
  "На абонементе закончились тренировки": "No workouts left on your membership",
  "Тренировка не найдена": "Workout not found",
  "Эта тренировка уже прошла": "This workout has already taken place",
  "Свободных мест больше нет": "No spots left",
  "Вы не были записаны на эту тренировку": "You weren't booked for this workout",
  "Вы вышли из листа ожидания": "You've left the waitlist",
  "Запись отменена": "Booking cancelled",
  "Мест нет — вы в листе ожидания": "The workout is full — you're on the waitlist",
  "Вы записаны на тренировку": "You're booked for the workout",
  "Сейчас у вас нет действующего абонемента — выбрать его можно в студии.":
    "You don't have an active membership right now — you can choose one at the studio.",
  "Вы записаны на тренировку в студии «{name}»": "You're booked for the workout at «{name}»",
  "Не удалось выполнить действие: {reason}": "Something went wrong: {reason}",
  "Выберите день и запишитесь на тренировку": "Pick a day and book a workout",
  "Совсем скоро мы начнем принимать заявки на персональные тренировки":
    "We'll start taking personal training requests very soon",
  "Функционал скоро будет доступен": "Coming soon",
  "Все тренировки": "All workouts",
  "Все тренеры": "All trainers",
  Сбросить: "Reset",
  "Ошибка загрузки: {error}": "Loading error: {error}",
  "На этот день таких тренировок нет": "No matching workouts on this day",
  "На этот день тренировок пока нет": "No workouts on this day yet",
  "В ближайшие дни в расписании пусто.": "The schedule is empty for the coming days.",
  "Сменить студию": "Switch studio",
  "Выберите студию": "Choose a studio",
  "Новости, услуги, расписание и абонементы покажем для выбранной студии.":
    "News, services, the schedule and memberships will be shown for the selected studio.",
  "Ваша студия — здесь можно записываться": "Your studio — you can book here",
  "Не удалось загрузить карточку тренера. Попробуйте ещё раз.":
    "Couldn't load the trainer's profile. Please try again.",
  "Рассказ о тренере скоро появится.": "The trainer's bio is coming soon.",
  "Пока нет отзывов": "No reviews yet",
  "Рейтинг {value} из 5, {reviews}": "Rated {value} out of 5, {reviews}",
  "Поблагодарить тренера": "Thank your trainer",
  "Оставить чаевые": "Leave a tip",
  "Спасибо за оценку!": "Thanks for your rating!",
  "Оценка изменена": "Rating updated",
  "Не удалось отправить оценку. Попробуйте ещё раз.":
    "Couldn't send your rating. Please try again.",
  "Ваша оценка": "Your rating",
  "Оцените тренера": "Rate your trainer",
  Оценка: "Rating",
  "{n} из 5": "{n} out of 5",
  Отмена: "Cancel",
  "Отправляем…": "Sending…",
  Сохранить: "Save",
  Отправить: "Submit",
  Изменить: "Edit",
  "{n} отзыв|{n} отзыва|{n} отзывов": "{n} review|{n} reviews",
  Тренеры: "Trainers",
  Студия: "Studio",
  "Не удалось загрузить сотрудников. Обновите страницу.":
    "Couldn't load the team. Please refresh the page.",
  "Тренеры студии скоро появятся": "Studio trainers are coming soon",
  Админы: "Admins",
  Массажисты: "Massage therapists",
  "Администраторы студии": "Studio administrators",
  "Администраторы студии скоро появятся": "Studio administrators are coming soon",
  "Массажисты студии": "Studio massage therapists",
  "Массажисты студии скоро появятся": "Studio massage therapists are coming soon",
  Администратор: "Administrator",
  "Поблагодарить администратора": "Thank your administrator",
  "Рассказ об администраторе скоро появится.": "The administrator's bio is coming soon.",
  "Руководитель студии": "Studio manager",
  Массажист: "Massage therapist",
  "Поблагодарить массажиста": "Thank your massage therapist",
  "Записаться на массаж": "Book a massage",
  "Оцените массажиста": "Rate your massage therapist",
  "Рассказ о массажисте скоро появится.": "The massage therapist's bio is coming soon.",
  Абонементы: "Memberships",
  "Персональные занятия": "Personal training",
  "Пакеты тренировок студии «{name}»": "Workout packages at “{name}”",
  "Пакеты тренировок": "Workout packages",
  "Войдите в аккаунт, чтобы увидеть абонементы.": "Log in to see memberships.",
  "Не удалось загрузить абонементы. Обновите страницу.":
    "Couldn't load memberships. Please refresh the page.",
  "Пакетов персональных занятий пока нет": "No personal training packages yet",
  "Абонементов пока нет": "No memberships yet",
  "Оформить у администратора": "Get it via the front desk",
  "Здравствуйте! Я {name}, клиент студии. Хочу оформить абонемент «{membership}».":
    "Hello! I'm {name}, a studio client. I'd like to get the “{membership}” membership.",
  "Здравствуйте! Хочу оформить абонемент «{membership}».":
    "Hello! I'd like to get the “{membership}” membership.",
  "Пробное посещение": "Trial class",
  "Можно оплатить частями — до {n} платежей": "Pay in up to {n} installments",
  "Что входит:": "What's included:",
  "В подарок": "Bonus gift",
  "Для вас — выгоднее": "Better price for you",
  "Здесь указана полная стоимость. Вы уже наш клиент, поэтому продление обойдётся дешевле — подробности у администратора.":
    "This is the full price. As our client, you'll pay less to renew — ask the front desk for details.",
  "Срок действия — {duration}": "Valid for {duration}",
  "Продление — начнётся, когда закончится текущий": "Renewal — starts when the current one ends",
  Заморожен: "Frozen",
  "Действует до {date}": "Valid until {date}",
  "Срок — с первого посещения": "Valid from your first visit",
  Абонемент: "Membership",
  "Осталось: {balance}": "Left: {balance}",
  "{n} месяц|{n} месяца|{n} месяцев": "{n} month|{n} months",
  "{n} день|{n} дня|{n} дней": "{n} day|{n} days",
  "{n} персональная тренировка|{n} персональные тренировки|{n} персональных тренировок":
    "{n} personal training session|{n} personal training sessions",
  "{n} тренировка|{n} тренировки|{n} тренировок": "{n} workout|{n} workouts",
  "{n} персональная|{n} персональные|{n} персональных":
    "{n} personal session|{n} personal sessions",
  "Вы записаны": "You're booked",
  "Начинается через {time}": "Starts in {time}",
  "{n} д": "{n} d",
  "{n} ч": "{n} h",
  Замена: "Substitute",
  "Следующий платёж": "Next payment",
  "Следующие платежи": "Next payments",
  просрочен: "overdue",
  // Заявки администратору и диагностика тела (schedule-requests.tsx, entries.ts, 2026-10-15).
  сегодня: "today",
  "Заявка отправлена {date}": "Request sent {date}",
  "Администратор свяжется с вами, чтобы подобрать тренера и согласовать расписание персональных занятий.":
    "The administrator will contact you to pick a trainer and agree on your personal training schedule.",
  "Администратор согласует время с тренером и добавит диагностику в ваше расписание.":
    "The administrator will agree on a time with the trainer and add the diagnostics to your schedule.",
  "Не удалось отправить заявку: {error}": "Couldn't send the request: {error}",
  "Заявка отправлена администратору": "Request sent to the administrator",
  "На балансе: {balance}": "Balance: {balance}",
  "Персональные тренировки": "Personal training",
  "Оставьте заявку — она придёт администратору студии. Администратор свяжется с вами, чтобы подобрать тренера и согласовать расписание персональных занятий.":
    "Leave a request — it goes to the studio administrator, who will contact you to pick a trainer and agree on your personal training schedule.",
  "Напишите вашу цель": "Write your goal",
  "Ваша цель": "Your goal",
  "Цель из вашей анкеты уже отмечена — можно добавить другие.":
    "The goal from your questionnaire is already selected — you can add others.",
  "Отметьте, чего хотите добиться, — можно несколько.":
    "Select what you want to achieve — you can choose several.",
  Комментарий: "Comment",
  "Удобные дни и время, пожелания к тренеру": "Convenient days and times, wishes for the trainer",
  "Отправить заявку": "Send request",
  "Диагностика отменена": "Diagnostics cancelled",
  "Диагностики входят в абонементы на 24, 36 и 50 занятий.":
    "Diagnostics are included in 24, 36 and 50-session memberships.",
  "Записаться на диагностику": "Book diagnostics",
  "Заявка поступит администратору — он согласует время с тренером и добавит диагностику в ваше расписание.":
    "Your request goes to the administrator, who will agree on a time with the trainer and add the diagnostics to your schedule.",
  "На ваших абонементах нет диагностик. Узнать, как их получить, можно у администратора студии.":
    "Your memberships don't include diagnostics. Ask the studio administrator how to get them.",
  "{n} диагностика|{n} диагностики|{n} диагностик":
    "{n} diagnostic session|{n} diagnostic sessions",
  "Индивидуальная встреча с тренером, чтобы тренировки давали лучший результат.":
    "A one-on-one session with a trainer so your workouts bring the best results.",
  "Заполняем анкету: цели, здоровье, ограничения.":
    "We fill in a questionnaire: goals, health, limitations.",
  "Делаем замеры и тест на баланс.": "We take measurements and do a balance test.",
  "Тренер составляет персональные рекомендации: с какой интенсивностью заниматься, на что обращать внимание и как восстанавливаться.":
    "The trainer prepares personal recommendations: what intensity to train at, what to pay attention to and how to recover.",
  "По результатам вы получаете свою персональную диагностическую карту — страничку с целями, замерами и планом тренировок.":
    "Afterwards you get your personal diagnostic card — a page with your goals, measurements and training plan.",
};

export default dict;

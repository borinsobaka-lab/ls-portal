import type { Dictionary } from "../types";

/** Раздел: анкета (онбординг) — подписочная и пакетная, общие вопросы. */
const dict: Dictionary = {
  // Общие шаги и подписи (components/onboarding.tsx, lib/onboarding.ts)
  Назад: "Back",
  Завершить: "Finish",
  Далее: "Next",
  "Какой у вас опыт тренировок?": "How much training experience do you have?",
  "Сколько раз в неделю вы сейчас двигаетесь или тренируетесь?":
    "How many times a week are you active or training right now?",
  "Есть что-то, о чём стоит знать тренеру?": "Is there anything your trainer should know?",
  "Отметьте, если актуально — тренер скорректирует нагрузку. Это не заменяет консультацию врача.":
    "Select if relevant — your trainer will adjust the load. This doesn't replace medical advice.",
  "Как планируете заниматься?": "How do you plan to train?",
  "Откуда вы о нас узнали?": "How did you hear about us?",
  "Сколько раз в неделю хотите ходить?": "How many times a week would you like to come?",
  "Удобное время": "Preferred time",
  "Кратко опишите, что важно учесть": "Briefly describe what we should keep in mind",
  "Новичок или большой перерыв": "Beginner or coming back after a long break",
  "Тренируюсь время от времени": "I train now and then",
  "Регулярно, 2–3 раза в неделю": "Regularly, 2–3 times a week",
  "Опытный, тренируюсь интенсивно": "Experienced, I train hard",
  "Почти не двигаюсь": "I barely move",
  "1 раз в неделю": "Once a week",
  "2–3 раза в неделю": "2–3 times a week",
  "4 и больше": "4 or more",
  "Спина или суставы": "Back or joints",
  "Сердце или давление": "Heart or blood pressure",
  "Недавняя травма или операция": "Recent injury or surgery",
  Беременность: "Pregnancy",
  "Хроническое заболевание": "Chronic condition",
  "Ничего из перечисленного": "None of the above",
  Необязательно: "Optional",
  Утро: "Morning",
  День: "Afternoon",
  Вечер: "Evening",
  "Instagram / соцсети": "Instagram / social media",
  "Рекомендация друга": "A friend recommended you",
  "Проходил(а) мимо": "Walked past",
  "Поиск / карты": "Search / maps",
  Другое: "Other",
  "Не удалось загрузить анкету. Обновите страницу.":
    "Couldn't load the questionnaire. Please refresh the page.",
  "Не удалось сохранить: {error}": "Couldn't save: {error}",
  "Анкета сохранена": "Questionnaire saved",
  Начать: "Start",
  "Что для вас главное прямо сейчас?": "What matters most to you right now?",
  "Базовые параметры — чтобы правильно рассчитать статистику":
    "A few basics — so we can calculate your stats correctly",
  "Эти данные увидите только вы и тренеры студии.":
    "Only you and the studio's trainers will see this.",
  "Эти данные увидите только вы и тренеры клуба.":
    "Only you and the club's trainers will see this.",
  Вес: "Weight",
  кг: "kg",

  // Подписочная анкета (routes/onboarding.tsx)
  "Знакомство — {brand}": "Getting to know you — {brand}",
  "Пара вопросов, чтобы следить за вашим прогрессом.":
    "A few questions so you can track your progress.",
  "Пара вопросов, чтобы настроить тренировки под вас.":
    "A few questions to tailor your workouts to you.",
  "Пара вопросов — и мы подстроим тренировки под вас":
    "A few questions — and we'll tailor your workouts to you",
  "Это займёт около 2 минут. Поможет тренеру подобрать правильную нагрузку с первого занятия.":
    "It takes about 2 minutes and helps your trainer set the right load from your very first class.",
  "Готово. Подготовим ваше первое занятие под вас.":
    "All set. We'll tailor your first class to you.",
  "До встречи в студии.": "See you at the studio.",
  "Снизить вес": "Lose weight",
  "Стать сильнее, набрать мышцы": "Get stronger, build muscle",
  "Поднять выносливость и форму": "Improve endurance and fitness",
  "Больше энергии и хорошее самочувствие": "More energy and feeling good",
  "Снять стресс, выработать привычку": "Relieve stress, build a habit",
  "Подготовиться к событию": "Get ready for an event",
  "Что вас к этому подтолкнуло?": "What made you decide to start?",
  "Можно в двух словах — это поможет нам лучше понять вас.":
    "Just a few words — it helps us understand you better.",
  "Например: хочу чувствовать себя бодрее по утрам":
    "For example: I want to feel more energetic in the mornings",
  "Без спешки, в удовольствие": "No rush, just for fun",
  "Хочу результат за 1–3 месяца": "I want results in 1–3 months",
  "Готовлюсь к конкретной дате": "I'm getting ready for a specific date",
  "Есть ли у вас срок?": "Do you have a deadline?",
  "Тренировались в групповом формате?": "Have you trained in a group before?",
  "Да, формат знаком": "Yes, I know the format",
  "Нет, будет впервые": "No, it'll be my first time",
  "Год рождения": "Year of birth",
  Пол: "Gender",
  Женский: "Female",
  Мужской: "Male",

  // Пакетная анкета (formats/packages/onboarding.tsx)
  "Стать гибче": "Become more flexible",
  "Снять напряжение и стресс": "Release tension and stress",
  "Подтянуть фигуру": "Tone my body",
  "Не удалось сохранить данные: {error}": "Couldn't save your details: {error}",
  "Пара вопросов — и вы сможете следить за своим прогрессом":
    "A few questions — and you'll be able to track your progress",
  "Это займёт около 2 минут. Ответы помогут отслеживать ваш прогресс, а нашим тренерам — давать вам рекомендации.":
    "It takes about 2 minutes. Your answers help track your progress and let our trainers give you recommendations.",
  "Спасибо, что поделились с нами!": "Thanks for sharing with us!",
  "Теперь вы сможете следить за своим прогрессом — ждём вас на тренировке в студии!":
    "Now you can track your progress — see you at a workout in the studio!",
  "Расскажите, чего хотите добиться": "Tell us what you want to achieve",
  "Дата рождения": "Date of birth",
  Фамилия: "Last name",
  Имя: "First name",
  "Номер телефона": "Phone number",
  "Последний шаг — заполните свои данные": "Last step — fill in your details",
  "Фамилия, имя и номер телефона — чтобы администратор студии мог с вами связаться. Что уже есть в студии, мы подставили.":
    "Your last name, first name and phone number — so the studio's admin can contact you. We've filled in what the studio already has.",
  "Фамилия, имя и номер телефона — чтобы администратор клуба мог с вами связаться. Что уже есть в клубе, мы подставили.":
    "Your last name, first name and phone number — so the club's admin can contact you. We've filled in what the club already has.",
  "Шаг {step} из {total}": "Step {step} of {total}",
  "Проверьте дату рождения": "Check your date of birth",
};

export default dict;

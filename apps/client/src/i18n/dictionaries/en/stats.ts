import type { Dictionary } from "../types";

/** Раздел: статистика на главной (components/stats-section.tsx — посещения, калории, сравнение со студией/клубом). */
const dict: Dictionary = {
  Кардио: "Cardio",
  Сила: "Strength",
  Гибрид: "Hybrid",
  "Восст.": "Recovery",
  Прочее: "Other",
  "Чтобы увидеть прогресс, посети первый класс — статистика появится автоматически.":
    "Attend your first class to see your progress — your stats will appear automatically.",
  Тренировка: "Workout",
  Персональные: "Personal training",
  Статистика: "Stats",
  "Прогресс, рекорды и ориентиры": "Progress, records and benchmarks",
  "Войдите, чтобы видеть свою персональную статистику тренировок.":
    "Log in to see your personal workout stats.",
  "Не удалось загрузить статистику. Обновите страницу.":
    "Couldn't load stats. Please refresh the page.",
  "{n} нед.": "{n} week|{n} weeks",
  "недель подряд с тренировками 🔥": "weeks in a row with workouts 🔥",
  "начни новую серию недель": "start a new weekly streak",
  "тренировок за всё время": "workouts in total",
  "до {goal} осталось {left}": "{left} to go until {goal}",
  "тренировок в этом месяце": "workouts this month",
  "активнее, чем {pct}% клиентов клуба": "more active than {pct}% of club members",
  "сравнение с клубом появится позже": "club comparison coming soon",
  "ккал сожжено за 30 дней": "kcal burned in 30 days",
  "укажите вес в профиле для расчёта": "add your weight in your profile to calculate",
  "больше, чем у {pct}% клиентов студии": "more than {pct}% of studio members",
  "больше, чем у {pct}% клиентов клуба": "more than {pct}% of club members",
  "оценка по интенсивности и длительности тренировок":
    "estimated from workout intensity and duration",
  "оценка по типу и длительности тренировки": "estimated from workout type and duration",
  "Перейти в профиль →": "Go to profile →",
  "{n} тип|{n} типа|{n} типов": "{n} type|{n} types",
  "разных видов тренировок": "different workout types",
  "тренировок в лучшем месяце": "workouts in your best month",
  "это твой личный рекорд!": "that's your personal best!",
  "до рекорда осталось {n}": "{n} to go for a new record",
  "вид тренировок|вида тренировок|видов тренировок": "workout type|workout types",
  "вы в топ-{pct}% студии по посещениям": "you're in the studio's top {pct}% by visits",
  "с нами с {date}": "with us since {date}",
  "сравнение со студией появится, когда наберётся статистика за месяц":
    "studio comparison will appear once there's a month of stats",
  "активнее, чем {pct}% клиенток студии": "more active than {pct}% of studio members",
  "в среднем по студии — {avg} за месяц": "studio average: {avg} a month",
  "Как считаются калории?": "How are calories calculated?",
  "Как мы считаем калории": "How we calculate calories",
  "Калории в приложении — это оценка. Точную цифру может дать только пульсометр или умные часы, но даже без них можно посчитать расход достаточно близко по проверенной методике, которую используют большинство фитнес-приложений.":
    "Calories in the app are an estimate. Only a heart rate monitor or a smartwatch can give an exact number, but even without one your burn can be estimated quite closely with a proven method used by most fitness apps.",
  "Мы опираемся на три параметра: <b>интенсивность тренировки</b>, её <b>длительность</b> и ваш <b>вес из профиля</b>. У каждой тренировки студии своя интенсивность — коэффициент <b>MET</b> (Metabolic Equivalent of Task), который показывает, во сколько раз активнее работает организм по сравнению с состоянием покоя. Чем выше интенсивность и дольше занятие — тем больше расход.":
    "We use three parameters: <b>workout intensity</b>, its <b>duration</b> and your <b>weight from your profile</b>. Each studio workout has its own intensity — the <b>MET</b> coefficient (Metabolic Equivalent of Task), which shows how many times harder your body works compared to rest. The higher the intensity and the longer the class, the more you burn.",
  "Мы опираемся на три параметра: <b>тип тренировки</b>, её <b>длительность</b> и ваш <b>вес из профиля</b>. У каждого типа занятия (кардио, силовая, гибрид, восстановление) своя интенсивность — коэффициент <b>MET</b> (Metabolic Equivalent of Task), который показывает, во сколько раз активнее работает организм по сравнению с состоянием покоя. Чем выше интенсивность и дольше занятие — тем больше расход.":
    "We use three parameters: <b>workout type</b>, its <b>duration</b> and your <b>weight from your profile</b>. Each class type (cardio, strength, hybrid, recovery) has its own intensity — the <b>MET</b> coefficient (Metabolic Equivalent of Task), which shows how many times harder your body works compared to rest. The higher the intensity and the longer the class, the more you burn.",
  "Важно, что калории фиксируются <b>персонально для вас</b> в момент каждой тренировки и <b>навсегда сохраняются в истории</b>. То есть если вы измените вес в профиле, прошлые тренировки не пересчитаются — каждая запись хранит ваш реальный показатель на тот день. Именно из этой истории и складывается вся ваша статистика.":
    "Importantly, calories are recorded <b>personally for you</b> at each workout and <b>saved in your history for good</b>. So if you change your weight in your profile, past workouts won't be recalculated — each entry keeps your real figure for that day. All your stats are built from this history.",
  "Сравнение со средним по студии полностью <b>анонимно</b> — мы показываем только обобщённые цифры, без чьих-либо имён, и обновляем их раз в сутки.":
    "The comparison with the studio average is fully <b>anonymous</b> — we only show aggregated figures, without anyone's names, and update them once a day.",
  "Сравнение со средним по клубу полностью <b>анонимно</b> — мы показываем только обобщённые цифры, без чьих-либо имён, и обновляем их раз в сутки.":
    "The comparison with the club average is fully <b>anonymous</b> — we only show aggregated figures, without anyone's names, and update them once a day.",
  "Помните: это <b>ориентир</b>, а не точное измерение. Реальный расход зависит ещё и от вашего пульса, состава тела и того, насколько вы выкладываетесь. Но для отслеживания динамики и сравнения с собой прошлым этой оценки более чем достаточно.":
    "Remember: this is a <b>guide</b>, not an exact measurement. Your actual burn also depends on your heart rate, body composition and how hard you push. But for tracking progress and comparing yourself with your past self, this estimate is more than enough.",
};

export default dict;

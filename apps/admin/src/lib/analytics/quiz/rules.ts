/**
 * Квиз-лендинги — правила их кода: тексты и логика лендинга (их
 * /opt/lady-quiz: index.html, app.js), приём заявки (POST /api/quiz/leads в
 * app.py и quiz_leads.create) и строка Google-таблицы (quiz_leads._row_values).
 * Без серверных зависимостей: берут и лендинг, и сервер портала.
 */
import { formatMsk } from "../core";
import { PY_WS, pyStrip } from "../onec/xlsx-read";

/** Их MAX_TEXT: поле заявки — не длиннее 300 знаков. */
export const QUIZ_MAX_TEXT = 300;
/** Их Content-Length: заявка — до 20 000 байт. */
export const QUIZ_MAX_BYTES = 20_000;
export const QUIZ_SHEET_NAME = "Заявки квиза";

/** Их ответы приёма заявки (app.py). */
export const QUIZ_TEXT = {
  rejected: "Не удалось отправить заявку. Попробуйте ещё раз.",
  forbidden: "Недопустимый источник заявки.",
  badRequest: "Некорректная заявка.",
  nameOrPhone: "Проверьте имя и телефон.",
  consent: "Нужно согласие на обработку данных.",
  noSheet: (city: string) => `Для города «${city}» не настроена таблица заявок.`,
} as const;

/** Их HEADERS: первая строка листа заявок, A1:P1. */
export const QUIZ_HEADERS = [
  "Дата и время",
  "Город",
  "Имя",
  "Телефон",
  "Рекомендация",
  "Запрос",
  "Длительность",
  "Барьер",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_referrer",
  "Согласие на ПДн",
  "ID заявки",
];
export const QUIZ_UTM_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "utm_referrer",
] as const;

const PY_WS_RUN = new RegExp(`${PY_WS}+`, "g");

/**
 * Их str(value or ""): пустое, 0, false, null — «»; True/False — как в
 * Python. Объекты и списки лендинг не присылает — для них JSON (у них —
 * repr Python).
 */
function pyStr(value: unknown): string {
  if (!value) return "";
  if (value === true) return "True";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value) ?? "";
}

/** Их _clean: пробелы подряд — один, по краям — без них, не длиннее limit знаков. */
export function quizClean(value: unknown, limit = QUIZ_MAX_TEXT): string {
  const text = pyStrip(pyStr(value).replace(PY_WS_RUN, " "));
  const chars = Array.from(text);
  return chars.length > limit ? chars.slice(0, limit).join("") : text;
}

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Заявка для базы (их поля quiz_leads, уже очищенные). */
export type QuizLeadInput = {
  city: string;
  name: string;
  phone: string;
  recommendation: string;
  pain: string;
  duration: string;
  barrier: string;
  utm: Record<string, string>;
  consentAt: string;
};

/**
 * Их приём заявки: проверка app.py (согласие есть) и quiz_leads.create —
 * город, имя от 2 знаков, в телефоне от 10 цифр, согласие; ответы теста,
 * рекомендация и UTM (ключи utm_*, до 40 знаков; пустые значения — нет).
 * Ошибка — их текст (клиенту уходит общий QUIZ_TEXT.rejected).
 */
export function quizLeadFromPayload(payload: unknown): QuizLeadInput {
  if (!isDict(payload) || !payload.consentAt) throw new Error(QUIZ_TEXT.consent);
  const city = quizClean(payload.city);
  const name = quizClean(payload.name);
  const phone = quizClean(payload.phone, 40);
  const consentAt = quizClean(payload.consentAt, 80);
  if (!city || Array.from(name).length < 2 || phone.replace(/\P{Nd}/gu, "").length < 10) {
    throw new Error(QUIZ_TEXT.nameOrPhone);
  }
  if (!consentAt) throw new Error(QUIZ_TEXT.consent);
  const answers = isDict(payload.answers) ? payload.answers : {};
  const utm: Record<string, string> = {};
  if (isDict(payload.utm)) {
    for (const [key, value] of Object.entries(payload.utm)) {
      if (!key.startsWith("utm_")) continue;
      const v = quizClean(value, 200);
      if (v) utm[quizClean(key, 40)] = v;
    }
  }
  return {
    city,
    name,
    phone,
    recommendation: quizClean(payload.recommendation),
    pain: quizClean(answers.pain),
    duration: quizClean(answers.duration),
    barrier: quizClean(answers.barrier),
    utm,
    consentAt,
  };
}

/** Неотправленная заявка (RPC an_quiz_pending). */
export type QuizPendingLead = {
  id: number;
  created_at: string;
  city: string;
  name: string;
  phone: string;
  recommendation: string;
  pain: string;
  duration: string;
  barrier: string;
  utm: Record<string, unknown>;
  consent_at: string;
  spreadsheet_id: string | null;
  sheet_name: string | null;
};

/** Их _row_values: строка листа (время заявки — «дд.мм.гггг чч:мм» по Москве). */
export function quizSheetRow(lead: QuizPendingLead): string[] {
  const utm = isDict(lead.utm) ? lead.utm : {};
  return [
    formatMsk(lead.created_at),
    lead.city,
    lead.name,
    lead.phone,
    lead.recommendation,
    lead.pain,
    lead.duration,
    lead.barrier,
    ...QUIZ_UTM_FIELDS.map((f) => (f in utm ? String(utm[f]) : "")),
    lead.consent_at,
    String(lead.id),
  ];
}

// --- Лендинг (их index.html и app.js) --------------------------------------------------

export type QuizAnswerKey = "pain" | "duration" | "barrier";

/** Их три вопроса: значение ответа и текст кнопки. */
export const QUIZ_QUESTIONS: {
  key: QuizAnswerKey;
  title: string;
  options: { value: string; text: string }[];
}[] = [
  {
    key: "pain",
    title: "Что из этого сейчас откликается больше всего?",
    options: [
      {
        value: "body",
        text: "Не нравится, как выглядит тело — но на диеты и обычный зал нет сил",
      },
      { value: "back", text: "Спина и шея постоянно зажаты после рабочего дня" },
      { value: "energy", text: "Вечно уставшая, ни на что не хватает энергии" },
      { value: "motivation", text: "Начинала тренироваться не раз — но каждый раз бросала" },
    ],
  },
  {
    key: "duration",
    title: "Как долго это уже продолжается?",
    options: [
      { value: "recent", text: "Только начала задумываться об этом" },
      { value: "months", text: "Уже несколько месяцев пытаюсь что-то поменять" },
      { value: "year", text: "Больше года — постоянно откладываю на потом" },
    ],
  },
  {
    key: "barrier",
    title: "Что обычно мешало довести тренировки до результата?",
    options: [
      { value: "time", text: "Не было своего времени в расписании" },
      { value: "alone", text: "Быстро надоедало заниматься в одиночку" },
      {
        value: "group",
        text: "Стеснялась в большой группе, где никто не следит за техникой",
      },
      { value: "plan", text: "Не было понятного плана — не знала, с чего начать" },
    ],
  },
];

/** Их labels: ответы в заявке и таблице — короткими фразами. */
export const QUIZ_LABELS: Record<QuizAnswerKey, Record<string, string>> = {
  pain: {
    body: "Не нравится тело, нет сил на диеты и зал",
    back: "Спина и шея зажаты после работы",
    energy: "Постоянная усталость и мало энергии",
    motivation: "Раньше начинала и бросала",
  },
  duration: {
    recent: "Только начала задумываться",
    months: "Несколько месяцев пытается изменить ситуацию",
    year: "Больше года откладывает изменения",
  },
  barrier: {
    time: "Не было времени в расписании",
    alone: "Надоедало заниматься в одиночку",
    group: "Стеснялась в большой группе",
    plan: "Не было понятного плана",
  },
};

/** Их recommendations: направление — по ответу на первый вопрос. */
export const QUIZ_RECOMMENDATIONS: Record<string, string> = {
  body: "Стройное тело с акцентом на ягодицы и пресс",
  back: "Здоровая спина",
  energy: "Функциональные петли или СТЕП-аэробика",
  motivation: "Скульптура тела",
};

/** Их argumentsByBarrier: довод — по ответу на третий вопрос. */
export const QUIZ_ARGUMENTS: Record<string, string> = {
  time: "Работаем с 9:00 до 21:00 без выходных — найдётся удобный слот.",
  alone: "В одном абонементе доступно 18+ направлений — можно менять формат и не скучать.",
  group: "У нас мини-группы до 8 человек: тренер видит и поправляет каждую.",
  plan: "На диагностике тренер составит понятный план — не нужно решать самой, с чего начать.",
};

export const QUIZ_LANDING_TEXT = {
  incomplete: "Пожалуйста, ответьте на вопросы теста.",
  failed: "Не удалось отправить заявку. Попробуйте ещё раз или свяжитесь со студией по телефону.",
} as const;

export type QuizAnswers = Partial<Record<QuizAnswerKey, string>>;

/** Их текст результата: «Рекомендуем направление — … . <довод>». */
export function quizResultText(answers: QuizAnswers): string {
  const rec = QUIZ_RECOMMENDATIONS[answers.pain ?? ""];
  return `Рекомендуем направление — ${rec}. ${QUIZ_ARGUMENTS[answers.barrier ?? ""]}`;
}

/** Их utm: все параметры адреса, начинающиеся с utm_ (повтор — последний). */
export function quizUtmFromSearch(search: string): Record<string, string> {
  return Object.fromEntries(
    [...new URLSearchParams(search)].filter(([key]) => key.startsWith("utm_")),
  );
}

/** Их payload заявки лендинга. */
export function quizPayload(p: {
  name: string;
  phone: string;
  city: string;
  citySlug: string;
  landingVersion: string;
  landingPath: string;
  answers: QuizAnswers;
  utm: Record<string, string>;
  consentAt?: string;
}) {
  return {
    name: p.name.trim(),
    phone: p.phone.trim(),
    city: p.city,
    citySlug: p.citySlug,
    source: "quiz",
    landingVersion: p.landingVersion,
    landingPath: p.landingPath,
    consentAt: p.consentAt ?? new Date().toISOString(),
    answers: {
      pain: QUIZ_LABELS.pain[p.answers.pain ?? ""],
      duration: QUIZ_LABELS.duration[p.answers.duration ?? ""],
      barrier: QUIZ_LABELS.barrier[p.answers.barrier ?? ""],
    },
    recommendation: QUIZ_RECOMMENDATIONS[p.answers.pain ?? ""],
    utm: p.utm,
  };
}

/** Ссылка телефона студии из подписи: «+7 (962) …» → «tel:+7962…» (их phoneHref). */
export function quizPhoneHref(display: string): string {
  const digits = display.replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : "";
}

/** ID Google-таблицы из ссылки или самого ID (их spreadsheet_id). */
export function quizSpreadsheetId(value: string): string {
  const v = value.trim();
  const m = v.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : v;
}

/** Их <title> и description лендинга (цена в описании у них — 600 ₽ для всех городов). */
export const QUIZ_HEAD = {
  title: "Подбор тренировок в Lady Stretch",
  description:
    "Ответьте на три вопроса и получите персональную рекомендацию по тренировкам и пробное занятие за 600 ₽.",
} as const;

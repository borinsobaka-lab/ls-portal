/** Способ оплаты продаж (sales.payment_type, other_sales.payment_method). */
export type PaymentMethod = "cash" | "card" | "transfer" | "app";

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "Наличные",
  card: "Карта",
  transfer: "Перевод",
  app: "Приложение",
};

export const PAYMENT_METHODS = Object.keys(PAYMENT_METHOD_LABEL) as PaymentMethod[];

/** Откуда продажа: из админки (портал) или из клиентского приложения. */
export type SaleSource = "admin" | "mobile";

export function saleSourceLabel(source: string | null | undefined) {
  return source === "mobile" ? "Приложение" : "Портал";
}

/** Тип оплаты продажи абонемента (sales.payment_type) — для отчётов. */
export type PaymentType = "first" | "recurring" | "other";

export const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  first: "Первая оплата",
  recurring: "Регулярная оплата",
  other: "Другое",
};
export const PAYMENT_TYPES: PaymentType[] = ["first", "recurring", "other"];

/**
 * Номенклатура пакетной студии (memberships.kind): пакет тренировок, пакет
 * персональных тренировок, разовое посещение или пробное посещение. Пакет
 * тренировок, разовое и пробное расходуются на групповых занятиях
 * (visits_left), пакет персональных — на персональных (personal_left; туда
 * же — подарочные персональные пакета тренировок, memberships.personal_count).
 * Подписочный формат тип не использует.
 */
export type MembershipKind = "package" | "personal" | "single" | "trial";

export const MEMBERSHIP_KIND_LABEL: Record<MembershipKind, string> = {
  package: "Пакет тренировок",
  personal: "Пакет персональных тренировок",
  single: "Разовое посещение",
  trial: "Пробное посещение",
};
export const MEMBERSHIP_KINDS: MembershipKind[] = ["package", "personal", "single", "trial"];

/**
 * Разовое посещение (memberships.kind = single, 2026-10-15): условия
 * постоянные — их же проверяет база (memberships_single_terms_check,
 * db/migrations/2026-10-15_zz_packages_single_visit.sql). Стоимость задают в
 * «Номенклатурах». Продаёт только администратор: в приложении разового нет.
 */
export const SINGLE_VISIT = {
  name: "Разовое посещение",
  visits: 1,
  durationDays: 30,
  payments: 1,
} as const;

/**
 * Тип продажи пакетной студии (sales.sale_kind) — для аналитики: сколько
 * продали сразу в студии, сколько допродали потом (например, в чате), сколько
 * продлили. null — продажа без типа (подписочный формат, приложение).
 */
export type SaleKind = "new" | "trial" | "upsell" | "renewal";

export const SALE_KIND_LABEL: Record<SaleKind, string> = {
  new: "Новая продажа",
  trial: "Оплата пробного",
  upsell: "Допродажа",
  renewal: "Продление",
};
export const SALE_KINDS: SaleKind[] = ["new", "trial", "upsell", "renewal"];

/** Цвет типа продажи — кружок в колонке «Тип продажи» и плашка иконки в выборе типа. */
export const SALE_KIND_DOT: Record<SaleKind, string> = {
  new: "bg-emerald-500",
  trial: "bg-emerald-500",
  upsell: "bg-blue-500",
  renewal: "bg-violet-500",
};

/** Короткое пояснение на плитке выбора типа продажи. */
export const SALE_KIND_DESCRIPTION: Record<SaleKind, string> = {
  new: "Продажа пакета в клубе",
  trial: "Пробное посещение из «Номенклатур»",
  upsell: "Продали позже — например, в чате",
  renewal: "Новый пакет клиенту, у которого уже были абонементы",
};

/** Пояснение под заголовком диалога продажи — по типу. */
export const SALE_KIND_HINT: Record<SaleKind, string> = {
  new: "Продажа в клубе. Выберите клиента и пакет — стоимость подтянется автоматически.",
  trial: "Продажа пробного посещения. Пробное из «Номенклатур» подставится само.",
  upsell:
    "Продажа позже первого визита — например, в чате. Заполняется как обычная продажа, в отчётах учитывается отдельно.",
  renewal:
    "Новый пакет клиенту, у которого уже были абонементы. Заполняется как обычная продажа, в отчётах учитывается отдельно.",
};

/** Подсказки «?»: у полей формы продажи и у колонок таблицы «Продаж». */
/**
 * Подтверждение удаления продажи абонемента («Продажи», «Абонементы»):
 * продажа и выданный по ней абонемент клиента удаляются вместе
 * (db/migrations/2026-10-11_zzzzzz_sale_membership_delete.sql).
 */
export function saleDeleteDescription(clientName: string | null, membershipName: string | null) {
  const what = [clientName, membershipName && `«${membershipName}»`].filter(Boolean).join(", ");
  return (
    (what ? `${what}. ` : "") +
    "Продажа и выданный по ней абонемент удалятся вместе: абонемент пропадёт у клиента в приложении, " +
    "удалятся и платежи рассрочки, и возвраты по продаже. Отмеченные посещения останутся. " +
    "Если продажа заменила прежний абонемент клиента и его срок не вышел, прежний снова станет действующим."
  );
}

/**
 * «Добавлен» в «Абонементах» — client_packages_list.added_via
 * (db/migrations/2026-10-18_zzz_client_packages_added_via.sql).
 */
export type SaleAddedVia = "admin" | "import" | "mobile";

export const SALE_ADDED_VIA_LABEL: Record<SaleAddedVia, string> = {
  admin: "Админка",
  import: "Из 1С",
  mobile: "Приложение",
};

export const SALE_TIPS = {
  soldAt: "С этой даты начинается абонемент: от неё считается срок действия и график рассрочки.",
  membership:
    "Тарифы из «Номенклатур». Если у клиента уже есть действующий или замороженный абонемент, новый его заменит. В пакетном клубе пакет персональных заменяет только пакет персональных, пакет тренировок — только пакет тренировок.",
  paymentType: "Для отчётов: первая покупка, регулярное продление или прочее.",
  promo: "Только пометка для учёта — скидку сам не считает. Уменьшите «Стоимость» вручную.",
  amount:
    "Подставляется цена тарифа. Уменьшите её, чтобы дать скидку, — разница сохранится как скидка.",
  downPayment: "Сколько клиент платит сегодня. Остаток делится поровну на следующие платежи.",
  installments: "На сколько месяцев разбить остаток. Платежи — раз в месяц от даты продажи.",
  paymentsCount:
    "Сколькими платежами клиент оплатит пакет. Максимум задан в «Номенклатурах». Платежи — раз в месяц от даты продажи.",
  firstPayment:
    "Сколько клиент внёс на месте в клубе. Остаток делится поровну на следующие платежи.",
  trainer:
    "Тренер, который был с клиентом, когда тот купил абонемент (например, вёл пробное). За продажу ему начисляется бонус к зарплате. Не было — оставьте «Без тренера».",
  saleKind:
    "Новая продажа — в клубе, пробное — пробное посещение, допродажа — продали позже (например, в чате), продление — клиенту, у которого уже были абонементы.",
};

// Календарная арифметика по Y-M-D: без Date-парсинга (он читает дату как UTC)
// и с прижатием к концу месяца — 31 января + 1 мес. = 28/29 февраля, а не 3 марта.
export function addMonthsISO(iso: string, months: number) {
  const [y, m, d] = iso.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/**
 * Сколько не хватает графику платежей до стоимости продажи («Редактировать
 * платежи» в «Абонементах»): 0 — график покрывает стоимость. Считается в
 * тетри (копейках), чтобы 33,33 + 33,33 + 33,34 давали ровно 100.
 */
export function scheduleShortfall(total: number, amounts: number[]): number {
  const cents = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100);
  const missing = cents(total) - amounts.reduce((sum, a) => sum + cents(a), 0);
  return Math.max(0, missing) / 100;
}

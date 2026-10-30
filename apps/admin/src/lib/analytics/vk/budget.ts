/**
 * VK Ads — «Контроль бюджетов» (их vk_ads.py: `evaluate_budget_alerts`,
 * `dispatch_budget_alerts`, `send_telegram_test`, проверки
 * `save_telegram_settings` / `save_partner_notification_channel`): прогноз
 * остатка по средним тратам за 7 полных дней, уровень предупреждения,
 * рекомендация пополнения и тексты Telegram. Числа — как их Decimal
 * (28 значащих цифр, округление к чётному).
 */
import { pyFloatStr } from "../reviews/parse";

// --- Decimal Python (контекст по умолчанию) ---------------------------------------

const PREC = 28;
const pow10 = (k: number) => 10n ** BigInt(k);
const abs = (v: bigint) => (v < 0n ? -v : v);
const digits = (v: bigint) => (v === 0n ? 1 : abs(v).toString().length);

/** Деление с округлением к чётному (знак — у результата). */
function divHalfEven(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const an = abs(n);
  const ad = abs(d);
  let q = an / ad;
  const r = an % ad;
  if (r * 2n > ad || (r * 2n === ad && q % 2n === 1n)) q += 1n;
  return neg ? -q : q;
}

/** Число m × 10^e. */
export class Dec {
  constructor(
    readonly m: bigint,
    readonly e: number,
  ) {}

  /** Decimal(str): «123.45», «-0.5», «1e-05», «1.5E+16». */
  static parse(text: string): Dec {
    const s = text.trim();
    const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
    if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
      throw new Error(`Не число: ${text}`);
    }
    const frac = match[3] ?? "";
    const m = BigInt(`${match[1] === "-" ? "-" : ""}${match[2] || "0"}${frac}`);
    return new Dec(m, Number(match[4] ?? 0) - frac.length);
  }

  /** Decimal(str(x)) для числа с плавающей точкой. */
  static fromFloat(x: number): Dec {
    return Dec.parse(pyFloatStr(x));
  }

  static int(n: number | bigint): Dec {
    return new Dec(BigInt(n), 0);
  }

  /** Округление до PREC значащих цифр (к чётному), как результат операции. */
  private static rounded(m: bigint, e: number): Dec {
    const extra = digits(m) - PREC;
    if (extra <= 0) return new Dec(m, e);
    return new Dec(divHalfEven(m, pow10(extra)), e + extra);
  }

  private static align(a: Dec, b: Dec): [bigint, bigint, number] {
    const e = Math.min(a.e, b.e);
    return [a.m * pow10(a.e - e), b.m * pow10(b.e - e), e];
  }

  cmp(o: Dec): number {
    const [a, b] = Dec.align(this, o);
    return a < b ? -1 : a > b ? 1 : 0;
  }

  sub(o: Dec): Dec {
    const [a, b, e] = Dec.align(this, o);
    return Dec.rounded(a - b, e);
  }

  mul(o: Dec): Dec {
    return Dec.rounded(this.m * o.m, this.e + o.e);
  }

  /** Деление как Decimal.__truediv__: PREC значащих цифр, к чётному; точное — к «идеальному» порядку. */
  div(o: Dec): Dec {
    if (o.m === 0n) throw new Error("Деление на ноль");
    const ideal = this.e - o.e;
    if (this.m === 0n) return new Dec(0n, ideal);
    const neg = this.m < 0n !== o.m < 0n;
    const a = abs(this.m);
    const b = abs(o.m);
    const shift = digits(b) - digits(a) + PREC + 1;
    let e = ideal - shift;
    let q = shift >= 0 ? (a * pow10(shift)) / b : a / (b * pow10(-shift));
    const r = shift >= 0 ? (a * pow10(shift)) % b : a % (b * pow10(-shift));
    if (r !== 0n) {
      // Неточное: младший разряд не кратен 5, чтобы округление учло остаток.
      if (q % 5n === 0n) q += 1n;
    } else {
      while (e < ideal && q % 10n === 0n) {
        q /= 10n;
        e += 1;
      }
    }
    return Dec.rounded(neg ? -q : q, e);
  }

  /** quantize(Decimal(1), ROUND_CEILING). */
  ceilInt(): Dec {
    if (this.e >= 0) return new Dec(this.m * pow10(this.e), 0);
    const div = pow10(-this.e);
    let q = this.m / div;
    if (this.m % div !== 0n && this.m > 0n) q += 1n;
    return new Dec(q, 0);
  }

  /** f"{d:.{n}f}" — округление к чётному. */
  fixed(n: number): string {
    let m: bigint;
    if (this.e >= -n) m = this.m * pow10(this.e + n);
    else m = divHalfEven(this.m, pow10(-n - this.e));
    const neg = m < 0n || (m === 0n && this.m < 0n);
    const s = abs(m)
      .toString()
      .padStart(n + 1, "0");
    const body = n ? `${s.slice(0, -n)}.${s.slice(-n)}` : s;
    return neg ? `-${body}` : body;
  }

  /** Десятичная запись без порядка (для numeric). */
  toString(): string {
    if (this.e >= 0) return (this.m * pow10(this.e)).toString();
    const neg = this.m < 0n;
    const s = abs(this.m)
      .toString()
      .padStart(-this.e + 1, "0");
    return `${neg ? "-" : ""}${s.slice(0, this.e)}.${s.slice(this.e)}`;
  }
}

// --- Прогноз и уровень --------------------------------------------------------------

export type BudgetSettings = {
  warning_days: string;
  critical_days: string;
  target_days: number;
};

export type BudgetInput = { balance: string | null; spent: number; days: number };

export type BudgetStage = "warning" | "critical" | "zero";

export type BudgetVerdict =
  | { kind: "skip" }
  /** Средние траты ≤ 0 — все предупреждения кабинета снимаются (их не считают). */
  | { kind: "no_spend" }
  /** Запас выше порогов — предупреждения снимаются (считаются в resolved). */
  | { kind: "ok" }
  | {
      kind: "alert";
      stage: BudgetStage;
      balance: Dec;
      average: Dec;
      forecast: Dec;
      recommended: Dec;
    };

/** Их evaluate_budget_alerts для одного кабинета. */
export function budgetVerdict(input: BudgetInput, s: BudgetSettings): BudgetVerdict {
  if (input.balance === null) return { kind: "skip" };
  if (input.days < 7) return { kind: "skip" };
  const balance = Dec.parse(input.balance);
  const average = Dec.fromFloat(input.spent).div(Dec.int(7));
  if (average.cmp(Dec.int(0)) <= 0) return { kind: "no_spend" };
  const forecast = balance.div(average);
  let recommended = average.mul(Dec.int(s.target_days)).sub(balance);
  if (recommended.cmp(Dec.int(0)) < 0) recommended = Dec.int(0);
  recommended = recommended.ceilInt();
  const stage: BudgetStage | "" =
    balance.cmp(Dec.int(0)) <= 0
      ? "zero"
      : forecast.cmp(Dec.parse(s.critical_days)) <= 0
        ? "critical"
        : forecast.cmp(Dec.parse(s.warning_days)) <= 0
          ? "warning"
          : "";
  if (!stage) return { kind: "ok" };
  return { kind: "alert", stage, balance, average, forecast, recommended };
}

/** Их подписи уровней на странице. */
export const BUDGET_STAGE_LABEL: Record<BudgetStage, string> = {
  warning: "Остаток до 3 дней",
  critical: "Остаток до 1 дня",
  zero: "Баланс исчерпан",
};

const TG_LEVEL: Record<BudgetStage, string> = {
  warning: "⚠️ Остаток заканчивается",
  critical: "🔶 Критический остаток",
  zero: "🔴 Баланс исчерпан",
};

/** Их текст предупреждения партнёру. */
export function budgetAlertText(a: {
  stage: BudgetStage;
  name: string;
  city: string;
  balance: string;
  average_daily_spend: string;
  forecast_days: string;
  recommended_topup: string;
}): string {
  return (
    `${TG_LEVEL[a.stage]}\n\n` +
    `Кабинет: ${a.name}\n` +
    `Город: ${a.city || "не назначен"}\n` +
    `Остаток: ${Dec.parse(a.balance).fixed(2)} ₽\n` +
    `Средние траты: ${Dec.parse(a.average_daily_spend).fixed(0)} ₽/день\n` +
    `Хватит примерно на: ${Dec.parse(a.forecast_days).fixed(1)} дн.\n\n` +
    `Рекомендуем пополнить на 7 дней: ${Dec.parse(a.recommended_topup).fixed(0)} ₽`
  );
}

export const TG_TEST_TEXT =
  "✅ Lady Stretch — проверка уведомлений\n\n" +
  "Бот подключён к порталу. Когда бюджет кабинета будет заканчиваться, " +
  "здесь появится рекомендация по сумме пополнения на 7 дней.";

/** ID чата Telegram: цифры, у группы — с минусом, до 32 знаков. */
export const tgChatIdOk = (id: string) => /^-?\d+$/.test(id) && id.length <= 32;

/** Их проверки save_telegram_settings; возвращает очищенные значения. */
export function tgSettingsCheck(v: {
  token: string;
  botUsername: string;
  testChatId: string;
  gatewayUrl: string;
  gatewaySecret: string;
}) {
  const username = v.botUsername.trim().replace(/^@+/, "").slice(0, 100);
  const chatId = v.testChatId.trim();
  const gateway = v.gatewayUrl.trim().replace(/\/+$/, "");
  if (chatId && !tgChatIdOk(chatId)) {
    throw new Error(
      "ID тестового чата должен состоять только из цифр (для группы может начинаться с -).",
    );
  }
  if (v.token.trim() && !v.token.trim().includes(":")) {
    throw new Error("Токен Telegram выглядит некорректно.");
  }
  if (gateway) {
    let ok = false;
    try {
      const u = new URL(gateway);
      ok = u.protocol === "https:" && u.hostname.endsWith(".workers.dev");
    } catch {
      ok = false;
    }
    if (!ok)
      throw new Error("Адрес шлюза должен быть HTTPS-адресом Worker Cloudflare (*.workers.dev).");
  }
  if (v.gatewaySecret.trim() && v.gatewaySecret.trim().length < 24) {
    throw new Error("Секрет шлюза слишком короткий.");
  }
  return { username, chatId, gateway, token: v.token.trim(), secret: v.gatewaySecret.trim() };
}

export type TgChat = { id: string; title: string; type: string };

/** Их telegram_chat_candidates: чаты из getUpdates, по названию. */
export function tgChatsFromUpdates(updates: unknown): TgChat[] {
  const chats = new Map<string, TgChat>();
  for (const u of Array.isArray(updates) ? updates : []) {
    const up = (u ?? {}) as Record<string, unknown>;
    const message = (up.message || up.my_chat_member || up.channel_post || {}) as Record<
      string,
      unknown
    >;
    const chat = (message.chat || {}) as Record<string, unknown>;
    const id = chat.id === undefined || chat.id === null ? "" : String(chat.id);
    if (!id) continue;
    const person = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
    const title = String(chat.title || person || chat.username || "Без названия");
    chats.set(id, { id, title, type: String(chat.type ?? "") });
  }
  return [...chats.values()].sort((a, b) =>
    a.title.toLowerCase() < b.title.toLowerCase()
      ? -1
      : a.title.toLowerCase() > b.title.toLowerCase()
        ? 1
        : 0,
  );
}

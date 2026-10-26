import { describe, expect, test } from "bun:test";

import {
  buildEmail,
  buildEmails,
  emailBrand,
  emailLocale,
  emailSender,
  isAdminApp,
  isPackagesApp,
  needsClubMembership,
  type HookPayload,
} from "./auth-email";

const payload = (redirect_to: string, email_action_type = "magiclink"): HookPayload => ({
  user: { id: "u1", email: "owner@example.com" },
  email_data: {
    token: "1234",
    token_hash: "hash",
    redirect_to,
    email_action_type,
    site_url: "https://admin.base40.fit",
  },
});

const ADMIN = "https://admin.base40.fit/";
const CLIENT = "https://app.base40.fit/";

const hasCode = (html: string) => html.includes("1234");
// Ссылка авто-входа — любая ссылка или token_hash (из него собирается
// /auth/v1/verify). В письмах авторизации их быть не должно.
const hasLoginLink = (html: string) =>
  html.includes("/auth/v1/verify") || html.includes("href") || html.includes("hash");

describe("isAdminApp — признак приложения по redirect_to", () => {
  test("админка", () => expect(isAdminApp(ADMIN)).toBe(true));
  test("клиентское приложение", () => expect(isAdminApp(CLIENT)).toBe(false));
  test("подделка хоста не проходит", () =>
    expect(isAdminApp("https://admin.base40.fit.evil.com/")).toBe(false));
  test("пустой redirect — считаем клиентом", () => expect(isAdminApp("")).toBe(false));
  test("мусор вместо URL — считаем клиентом", () => expect(isAdminApp("не-url")).toBe(false));
});

describe("вход: всегда код, приложение меняет только текст", () => {
  test("клиентское приложение — код, без ссылки", () => {
    const { html, subject } = buildEmail(payload(CLIENT), isAdminApp(CLIENT));
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
    expect(subject).not.toContain("админ");
  });

  test("админка — код, без ссылки", () => {
    const { html, subject } = buildEmail(payload(ADMIN), isAdminApp(ADMIN));
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
    expect(subject).toContain("админ");
  });

  test("один и тот же человек в двух приложениях получает разные письма", () => {
    const asClient = buildEmail(payload(CLIENT), isAdminApp(CLIENT));
    const asStaff = buildEmail(payload(ADMIN), isAdminApp(ADMIN));
    expect(asClient.subject).not.toBe(asStaff.subject);
  });

  test("нераспознанный redirect — клиентское письмо с кодом", () => {
    const { html, subject } = buildEmail(payload(""), isAdminApp(""));
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
    expect(subject).not.toContain("админ");
  });
});

describe("остальные типы писем", () => {
  test("регистрация клиента — код", () => {
    const { html } = buildEmail(payload(CLIENT, "signup"), false);
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
  });

  // /recover у GoTrue публичный: ссылка в таком письме была бы входом без кода.
  test("восстановление доступа — код, без ссылки", () => {
    const { html } = buildEmail(payload(ADMIN, "recovery"), true);
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
  });

  test("приглашение — код, без ссылки", () => {
    const { html } = buildEmail(payload(ADMIN, "invite"), true);
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
  });

  test("смена почты — код", () => {
    const { html } = buildEmail(payload(CLIENT, "email_change"), false);
    expect(hasCode(html)).toBe(true);
  });

  test("неизвестный тип — код (безопасный откат)", () => {
    const { html } = buildEmail(payload(ADMIN, "reauthentication"), true);
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
  });
});

describe("смена почты — код уходит на новый адрес", () => {
  const change = (extra: Partial<HookPayload["email_data"]>): HookPayload => ({
    user: { id: "u1", email: "old@example.com", new_email: "new@example.com" },
    email_data: {
      token: "111111",
      token_hash: "h1",
      redirect_to: CLIENT,
      email_action_type: "email_change",
      site_url: CLIENT,
      ...extra,
    },
  });

  test("без Secure Email Change — одно письмо на новый адрес", () => {
    const emails = buildEmails(change({}), false);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("new@example.com");
    expect(emails[0].html).toContain("111111");
  });

  test("Secure Email Change — token на текущий адрес, token_new на новый", () => {
    const emails = buildEmails(change({ token_new: "222222", token_hash_new: "h2" }), false);
    expect(emails.map((e) => e.to)).toEqual(["old@example.com", "new@example.com"]);
    expect(emails[0].html).toContain("111111");
    expect(emails[1].html).toContain("222222");
  });

  test("прочие типы — одно письмо на user.email", () => {
    const emails = buildEmails(payload(CLIENT), false);
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("owner@example.com");
  });
});

describe("код входа в клиентское приложение — только члену клуба", () => {
  test("вход и регистрация из клиентского приложения — проверяем карточку", () => {
    expect(needsClubMembership(payload(CLIENT), false)).toBe(true);
    expect(needsClubMembership(payload(CLIENT, "signup"), false)).toBe(true);
    expect(needsClubMembership(payload(CLIENT, "recovery"), false)).toBe(true);
  });
  test("админка — без проверки карточки", () =>
    expect(needsClubMembership(payload(ADMIN), true)).toBe(false));
  test("смена почты вошедшим клиентом — без проверки", () =>
    expect(needsClubMembership(payload(CLIENT, "email_change"), false)).toBe(false));
});

describe("Lady Stretch — письма клиентам пакетных клубов", () => {
  const LS = "https://app.lady-stretch.one";
  const PACK = "https://pack.base40.fit/";

  test("приложение пакетов — по хосту, оба адреса", () => {
    expect(isPackagesApp(LS)).toBe(true);
    expect(isPackagesApp(PACK)).toBe(true);
    expect(isPackagesApp(CLIENT)).toBe(false);
    expect(isPackagesApp(ADMIN)).toBe(false);
    expect(isPackagesApp("https://app.lady-stretch.one.evil.com/")).toBe(false);
    expect(isPackagesApp("")).toBe(false);
  });

  test("бренд: пакеты — Lady Stretch, остальное — Base40", () => {
    expect(emailBrand(LS)).toBe("ladyStretch");
    expect(emailBrand(PACK)).toBe("ladyStretch");
    expect(emailBrand(CLIENT)).toBe("base40");
    expect(emailBrand(ADMIN)).toBe("base40");
    expect(emailBrand("")).toBe("base40");
  });

  test("вход — код Lady Stretch в розовом, без ссылки и без Base40", () => {
    const { html, subject } = buildEmail(payload(`${LS}/?lang=ru`), false, "ladyStretch");
    expect(subject).toBe("Код для входа — Lady Stretch");
    expect(hasCode(html)).toBe(true);
    expect(hasLoginLink(html)).toBe(false);
    expect(html).toContain("#f763fc");
    expect(html).toContain("#1a2027");
    expect(html).toContain("#ffffff");
    expect(html).not.toContain("Base40");
  });

  test("все типы писем Lady Stretch — без Base40 в теме", () => {
    for (const type of ["signup", "recovery", "invite", "email_change", "reauthentication"]) {
      const { subject, html } = buildEmail(payload(LS, type), false, "ladyStretch");
      expect(subject).toContain("Lady Stretch");
      expect(hasCode(html)).toBe(true);
    }
  });

  test("смена почты с двумя кодами — оба письма Lady Stretch", () => {
    const p: HookPayload = {
      user: { id: "u1", email: "old@example.com", new_email: "new@example.com" },
      email_data: {
        token: "111111",
        token_hash: "h1",
        token_new: "222222",
        redirect_to: LS,
        email_action_type: "email_change",
        site_url: LS,
      },
    };
    const emails = buildEmails(p, false, "ladyStretch");
    expect(emails).toHaveLength(2);
    for (const e of emails) expect(e.subject).toContain("Lady Stretch");
  });

  test("админка — всегда Base40, даже если передали Lady Stretch", () => {
    const { html, subject } = buildEmail(payload(ADMIN), true, "ladyStretch");
    expect(subject).toContain("Base40");
    expect(html).not.toContain("#f763fc");
  });

  test("отправитель Lady Stretch — адрес из LADY_STRETCH_MAIL_FROM", () =>
    expect(
      emailSender("ladyStretch", { LADY_STRETCH_MAIL_FROM: "noreply@lady-stretch.one" }),
    ).toEqual({ email: "noreply@lady-stretch.one", name: "Lady Stretch" }));

  test("без переменной (домен не подтверждён) — прежний адрес, имя Lady Stretch", () =>
    expect(emailSender("ladyStretch", {})).toEqual({
      email: "noreply@base40.fit",
      name: "Lady Stretch",
    }));

  test("мусор в переменной — прежний адрес", () =>
    expect(emailSender("ladyStretch", { LADY_STRETCH_MAIL_FROM: "Lady <x@y.z>" }).email).toBe(
      "noreply@base40.fit",
    ));

  test("Base40 — прежний отправитель, переменная Lady Stretch не влияет", () =>
    expect(emailSender("base40", { LADY_STRETCH_MAIL_FROM: "noreply@lady-stretch.one" })).toEqual({
      email: "noreply@base40.fit",
      name: "Base40",
    }));
});

describe("язык письма клиенту — выбранный в приложении, иначе английский", () => {
  const withMeta = (redirect_to: string, locale: unknown): HookPayload => ({
    ...payload(redirect_to),
    user: { id: "u1", email: "owner@example.com", user_metadata: { locale } },
  });

  test("?lang= в redirect_to", () => {
    expect(emailLocale(payload(`${CLIENT}?lang=ka`), false)).toBe("ka");
    expect(emailLocale(payload(`${CLIENT}?lang=ru`), false)).toBe("ru");
    expect(emailLocale(payload(`${CLIENT}?lang=en`), false)).toBe("en");
  });

  test("без языка — английский", () => {
    expect(emailLocale(payload(CLIENT), false)).toBe("en");
    expect(emailLocale(payload(""), false)).toBe("en");
    expect(emailLocale(payload(`${CLIENT}?lang=de`), false)).toBe("en");
  });

  test("нет ?lang= — язык из метаданных учётной записи", () => {
    expect(emailLocale(withMeta(CLIENT, "ka"), false)).toBe("ka");
    expect(emailLocale(withMeta(CLIENT, "xx"), false)).toBe("en");
    // Язык экрана входа важнее сохранённого при создании учётной записи.
    expect(emailLocale(withMeta(`${CLIENT}?lang=ru`, "ka"), false)).toBe("ru");
  });

  test("админка — по-русски, что бы ни пришло", () =>
    expect(emailLocale(payload(`${ADMIN}?lang=en`), true)).toBe("ru"));

  test("по умолчанию клиентское письмо — английское, без кириллицы", () => {
    for (const brand of ["base40", "ladyStretch"] as const) {
      for (const type of ["magiclink", "signup", "recovery", "invite", "email_change", "x"]) {
        const { subject, html } = buildEmail(payload(CLIENT, type), false, brand);
        expect(hasCode(html)).toBe(true);
        expect(/[а-яё]/i.test(subject + html)).toBe(false);
      }
    }
    expect(buildEmail(payload(CLIENT), false).subject).toBe("Your sign-in code — Base40");
  });

  test("грузинский — без кириллицы", () => {
    for (const type of ["magiclink", "signup", "recovery", "invite", "email_change", "x"]) {
      const { subject, html } = buildEmail(
        payload(`${CLIENT}?lang=ka`, type),
        false,
        "ladyStretch",
      );
      expect(hasCode(html)).toBe(true);
      expect(/[а-яё]/i.test(subject + html)).toBe(false);
      expect(/[\u10D0-\u10FF]/.test(subject)).toBe(true);
    }
  });

  test("смена почты с двумя кодами — оба письма на языке клиента", () => {
    const p: HookPayload = {
      user: { id: "u1", email: "old@example.com", new_email: "new@example.com" },
      email_data: {
        token: "111111",
        token_hash: "h1",
        token_new: "222222",
        redirect_to: `${CLIENT}?lang=en`,
        email_action_type: "email_change",
        site_url: CLIENT,
      },
    };
    for (const e of buildEmails(p, false))
      expect(e.subject).toBe("Confirm your email change — Base40");
  });

  test("админка — русское письмо", () => {
    const { subject, html } = buildEmail(payload(`${ADMIN}?lang=en`), true);
    expect(subject).toBe("Код для входа в админ-панель Base40");
    expect(html).toContain("Код действует 1 час.");
  });
});

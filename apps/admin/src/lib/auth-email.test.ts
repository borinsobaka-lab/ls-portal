import { describe, expect, test } from "bun:test";

// Адреса приложений — из окружения (DEPLOY.md); в тестах — свои.
process.env.ADMIN_APP_URL = "https://portal.example.ru";
process.env.PACKAGES_APP_URLS = "https://app.example.ru,https://pack.example.ru";

import {
  buildEmail,
  buildEmails,
  emailBrand,
  emailLocale,
  emailSender,
  isAdminApp,
  portalBrand,
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
    site_url: "https://portal.example.ru",
  },
});

const ADMIN = "https://portal.example.ru/";
const CLIENT = "https://sub.example.ru/";

const hasCode = (html: string) => html.includes("1234");
// Ссылка авто-входа — любая ссылка или token_hash (из него собирается
// /auth/v1/verify). В письмах авторизации их быть не должно.
const hasLoginLink = (html: string) =>
  html.includes("/auth/v1/verify") || html.includes("href") || html.includes("hash");

describe("isAdminApp — признак приложения по redirect_to", () => {
  test("админка", () => expect(isAdminApp(ADMIN)).toBe(true));
  test("клиентское приложение", () => expect(isAdminApp(CLIENT)).toBe(false));
  test("подделка хоста не проходит", () =>
    expect(isAdminApp("https://portal.example.ru.evil.com/")).toBe(false));
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
    expect(subject).toContain("портал");
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
  const LS = "https://app.example.ru";
  const PACK = "https://pack.example.ru/";

  test("приложение пакетов — по хосту, оба адреса", () => {
    expect(isPackagesApp(LS)).toBe(true);
    expect(isPackagesApp(PACK)).toBe(true);
    expect(isPackagesApp(CLIENT)).toBe(false);
    expect(isPackagesApp(ADMIN)).toBe(false);
    expect(isPackagesApp("https://app.example.ru.evil.com/")).toBe(false);
    expect(isPackagesApp("")).toBe(false);
  });

  test("бренд: пакеты — Lady Stretch, портал — бренд портала (по умолчанию Lady Stretch)", () => {
    expect(emailBrand(LS, {})).toBe("ladyStretch");
    expect(emailBrand(PACK, {})).toBe("ladyStretch");
    expect(emailBrand(CLIENT, {})).toBe("ladyStretch");
    expect(emailBrand(ADMIN, {})).toBe("ladyStretch");
    expect(emailBrand("", {})).toBe("ladyStretch");
    expect(emailBrand(CLIENT, { EMAIL_BRAND: "base40" })).toBe("base40");
    expect(emailBrand(ADMIN, { EMAIL_BRAND: "base40" })).toBe("base40");
    expect(emailBrand(LS, { EMAIL_BRAND: "base40" })).toBe("ladyStretch");
    expect(portalBrand({ EMAIL_BRAND: "что-то" })).toBe("ladyStretch");
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

  test("портал — бренд портала, даже если передали Base40", () => {
    const { html, subject } = buildEmail(payload(ADMIN), true, "base40");
    expect(subject).toBe("Код для входа в портал Lady Stretch");
    expect(html).toContain("#f763fc");
    expect(html).not.toContain("Base40");
  });

  test("отправитель — MAIL_FROM, имя — MAIL_FROM_NAME или бренд", () => {
    expect(emailSender("ladyStretch", { MAIL_FROM: "noreply@lady-stretching.ru" })).toEqual({
      email: "noreply@lady-stretching.ru",
      name: "Lady Stretch",
    });
    expect(
      emailSender("ladyStretch", { MAIL_FROM: "noreply@x.ru", MAIL_FROM_NAME: "Леди Стретч" }),
    ).toEqual({ email: "noreply@x.ru", name: "Леди Стретч" });
    expect(emailSender("base40", { MAIL_FROM: "noreply@x.ru" }).name).toBe("Base40");
  });

  test("без MAIL_FROM — логин SMTP; мусор в MAIL_FROM — тоже он", () => {
    expect(emailSender("ladyStretch", { SMTP_USER: "box@x.ru" }).email).toBe("box@x.ru");
    expect(
      emailSender("ladyStretch", { MAIL_FROM: "Lady <x@y.z>", SMTP_USER: "box@x.ru" }).email,
    ).toBe("box@x.ru");
  });
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
    expect(subject).toBe("Код для входа в портал Lady Stretch");
    expect(html).toContain("Код действует 1 час.");
  });
});

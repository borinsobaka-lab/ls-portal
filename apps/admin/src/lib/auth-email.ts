// Логика писем авторизации: какое письмо кому. Вынесена из роута
// src/routes/api/auth-email.ts, чтобы её можно было проверять тестом
// (bun test src/lib/auth-email.test.ts).

import { defaultSender, type MailSender } from "./mail";

export type HookPayload = {
  user: {
    id: string;
    email: string;
    // Новый адрес при смене почты (email_change).
    new_email?: string | null;
    user_metadata?: Record<string, unknown> | null;
  };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: string;
    site_url: string;
    token_new?: string;
    token_hash_new?: string;
  };
};

// Из какого приложения пришёл запрос. Разбирать redirect_to как URL
// обязательно: сравнение подстрокой пропустило бы, например,
// https://portal.example.ru.evil.com. Адрес портала — ADMIN_APP_URL
// (обязателен: без него хук не отвечает, src/routes/api/auth-email.ts).
export function isAdminApp(redirectTo: string | undefined): boolean {
  const host = hostOf(redirectTo);
  return host !== null && host === hostOf(process.env.ADMIN_APP_URL);
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

// Приложение пакетных клубов (Lady Stretch): адреса через запятую в
// PACKAGES_APP_URLS (пусто — приложение не развёрнуто).
export function isPackagesApp(redirectTo: string | undefined): boolean {
  const host = hostOf(redirectTo);
  if (!host) return false;
  return (process.env.PACKAGES_APP_URLS ?? "")
    .split(",")
    .some((url) => hostOf(url.trim()) === host);
}

// ---------------------------------------------------------------------------
// Бренд письма. Копия Lady Stretch (2026-10-26): письма портала (админки) и
// приложения пакетных клубов — Lady Stretch (розовый #f763fc, серые бокового
// меню); EMAIL_BRAND=base40 — прежний вид Base40 у портала и подписочного
// приложения.
// ---------------------------------------------------------------------------

export type EmailBrand = "base40" | "ladyStretch";

type Env = Record<string, string | undefined>;

/** Бренд писем портала и подписочного приложения (EMAIL_BRAND). */
export function portalBrand(env: Env = process.env): EmailBrand {
  return env.EMAIL_BRAND === "base40" ? "base40" : "ladyStretch";
}

export function emailBrand(redirectTo: string | undefined, env: Env = process.env): EmailBrand {
  return !isAdminApp(redirectTo) && isPackagesApp(redirectTo) ? "ladyStretch" : portalBrand(env);
}

const BRAND_NAME: Record<EmailBrand, string> = { base40: "Base40", ladyStretch: "Lady Stretch" };

/** Название в письмах: MAIL_FROM_NAME, иначе имя бренда. */
export function brandName(brand: EmailBrand, env: Env = process.env): string {
  return env.MAIL_FROM_NAME?.trim() || BRAND_NAME[brand];
}

/**
 * Отправитель письма — один ящик на все письма (MAIL_FROM, иначе логин
 * SMTP; src/lib/mail.ts), имя — название бренда.
 */
export function emailSender(brand: EmailBrand, env: Env = process.env): MailSender {
  return { email: defaultSender(env).email, name: brandName(brand, env) };
}

// Письма входа в КЛИЕНТСКОЕ приложение, которые уходят только члену клуба
// (есть карточка клиента — привязанная или свободная с той же почтой). Новую
// учётную запись без карточки не создаст handle_new_user, но уже
// существующей GoTrue шлёт код как есть — её и останавливает хук
// (db/migrations/2026-10-12_client_account_wipe.sql). Смена почты и
// переподтверждение — у вошедшего клиента, их не трогаем.
const CLIENT_SIGN_IN_ACTIONS = new Set(["magiclink", "signup", "recovery", "invite"]);

export function needsClubMembership(payload: HookPayload, fromAdminApp: boolean): boolean {
  return !fromAdminApp && CLIENT_SIGN_IN_ACTIONS.has(payload.email_data.email_action_type);
}

/** Сообщение для приложения: тот же признак, что у ensure_client_profile. */
export const NOT_A_CLUB_MEMBER = "not_a_club_member";

// ---------------------------------------------------------------------------
// Язык письма клиенту (решение владельца 2026-10-18): язык, выбранный в
// приложении, иначе английский — как и само приложение по умолчанию.
// Источники по порядку: ?lang= в redirect_to (экран входа добавляет язык,
// выбранный сейчас, — apps/client, use-auth.tsx), user_metadata.locale (его
// пишет signInWithOtp при создании учётной записи; у существующей GoTrue
// метаданные из запроса не обновляет). Письма админки — по-русски:
// интерфейс админки только русский.
// ---------------------------------------------------------------------------

export type EmailLocale = "en" | "ka" | "ru";

const isEmailLocale = (value: unknown): value is EmailLocale =>
  value === "en" || value === "ka" || value === "ru";

export function emailLocale(payload: HookPayload, fromAdminApp: boolean): EmailLocale {
  if (fromAdminApp) return "ru";
  try {
    const lang = new URL(payload.email_data.redirect_to).searchParams.get("lang");
    if (isEmailLocale(lang)) return lang;
  } catch {
    // нет redirect_to или не URL — смотрим метаданные
  }
  const meta = payload.user.user_metadata?.locale;
  return isEmailLocale(meta) ? meta : "en";
}

type EmailTexts = {
  ignore: string;
  validFor: string;
  validForPrivate: string;
  codeSubject: (name: string) => string;
  welcomeTitle: (name: string) => string;
  codeLead: string;
  signInSubject: (name: string) => string;
  signInTitle: (name: string) => string;
  signInLead: string;
  recoverySubject: (name: string) => string;
  recoveryTitle: string;
  recoveryLead: string;
  inviteSubject: (name: string) => string;
  inviteTitle: (name: string) => string;
  inviteLead: string;
  emailChangeSubject: (name: string) => string;
  emailChangeTitle: string;
  emailChangeOldLead: string;
  emailChangeNewLead: string;
  confirmTitle: string;
};

const TEXTS: Record<EmailLocale, EmailTexts> = {
  ru: {
    ignore: "Если вы не запрашивали это письмо — просто проигнорируйте его.",
    validFor: "Код действует 1 час.",
    validForPrivate: "Код действует 1 час. Никому его не сообщайте.",
    codeSubject: (name) => `Код подтверждения — ${name}`,
    welcomeTitle: (name) => `Добро пожаловать в ${name}!`,
    codeLead: "Ваш код подтверждения:",
    signInSubject: (name) => `Код для входа — ${name}`,
    signInTitle: (name) => `Вход в ${name}`,
    signInLead: "Ваш код для входа в приложение:",
    recoverySubject: (name) => `Восстановление доступа — ${name}`,
    recoveryTitle: "Восстановление доступа",
    recoveryLead: "Ваш код для восстановления доступа:",
    inviteSubject: (name) => `Приглашение в ${name}`,
    inviteTitle: (name) => `Вас пригласили в ${name}`,
    inviteLead: "Ваш код для принятия приглашения:",
    emailChangeSubject: (name) => `Подтверждение смены почты — ${name}`,
    emailChangeTitle: "Смена почты",
    emailChangeOldLead: "Код для подтверждения смены почты (с текущего адреса):",
    emailChangeNewLead: "Код для подтверждения новой почты:",
    confirmTitle: "Подтверждение действия",
  },
  en: {
    ignore: "If you didn't request this email, just ignore it.",
    validFor: "The code is valid for 1 hour.",
    validForPrivate: "The code is valid for 1 hour. Don't share it with anyone.",
    codeSubject: (name) => `Verification code — ${name}`,
    welcomeTitle: (name) => `Welcome to ${name}!`,
    codeLead: "Your verification code:",
    signInSubject: (name) => `Your sign-in code — ${name}`,
    signInTitle: (name) => `Sign in to ${name}`,
    signInLead: "Your code to sign in to the app:",
    recoverySubject: (name) => `Account recovery — ${name}`,
    recoveryTitle: "Account recovery",
    recoveryLead: "Your account recovery code:",
    inviteSubject: (name) => `Invitation to ${name}`,
    inviteTitle: (name) => `You've been invited to ${name}`,
    inviteLead: "Your code to accept the invitation:",
    emailChangeSubject: (name) => `Confirm your email change — ${name}`,
    emailChangeTitle: "Email change",
    emailChangeOldLead: "Code to confirm the email change (from your current address):",
    emailChangeNewLead: "Code to confirm your new email:",
    confirmTitle: "Confirm the action",
  },
  // Название бренда латиницей — без грузинских падежных окончаний: «{name}
  // გიწვევთ», «{name} — შესვლა».
  ka: {
    ignore: "თუ ეს წერილი არ მოგითხოვიათ, უბრალოდ უგულებელყავით.",
    validFor: "კოდი მოქმედებს 1 საათის განმავლობაში.",
    validForPrivate: "კოდი მოქმედებს 1 საათის განმავლობაში. არავის გაუზიაროთ.",
    codeSubject: (name) => `დადასტურების კოდი — ${name}`,
    welcomeTitle: (name) => `${name} მოგესალმებათ!`,
    codeLead: "თქვენი დადასტურების კოდი:",
    signInSubject: (name) => `შესვლის კოდი — ${name}`,
    signInTitle: (name) => `${name} — შესვლა`,
    signInLead: "თქვენი კოდი აპლიკაციაში შესასვლელად:",
    recoverySubject: (name) => `წვდომის აღდგენა — ${name}`,
    recoveryTitle: "წვდომის აღდგენა",
    recoveryLead: "თქვენი კოდი წვდომის აღსადგენად:",
    inviteSubject: (name) => `მოწვევა — ${name}`,
    inviteTitle: (name) => `${name} გიწვევთ`,
    inviteLead: "თქვენი კოდი მოწვევის მისაღებად:",
    emailChangeSubject: (name) => `ელფოსტის შეცვლის დადასტურება — ${name}`,
    emailChangeTitle: "ელფოსტის შეცვლა",
    emailChangeOldLead: "კოდი ელფოსტის შეცვლის დასადასტურებლად (მიმდინარე მისამართიდან):",
    emailChangeNewLead: "კოდი ახალი ელფოსტის დასადასტურებლად:",
    confirmTitle: "მოქმედების დადასტურება",
  },
};

// ---------------------------------------------------------------------------
// Письма. Инлайновые стили и литеральные цвета здесь уместны: это HTML почты,
// токены дизайн-системы приложения на неё не распространяются.
// ---------------------------------------------------------------------------

const wrapBase40 = (inner: string, tx: EmailTexts) => `
<div style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e4e4e7">
    <div style="font-size:20px;font-weight:900;font-style:italic;letter-spacing:0.04em">
      Base<span style="color:#d4be00">40</span>
    </div>
    <div style="margin-top:24px">${inner}</div>
    <p style="margin-top:28px;color:#a1a1aa;font-size:12px;line-height:1.5">
      ${tx.ignore}
    </p>
  </div>
</div>`;

const codeBase40 = (title: string, lead: string, token: string, tx: EmailTexts) =>
  wrapBase40(
    `
    <h2 style="margin:0;font-size:18px;color:#18181b">${title}</h2>
    <p style="color:#52525b;font-size:14px;line-height:1.5">${lead}</p>
    <div style="margin:20px 0;padding:16px;background:#fafafa;border:1px solid #e4e4e7;border-radius:12px;text-align:center">
      <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:#18181b">${token}</span>
    </div>
    <p style="color:#52525b;font-size:13px">${tx.validFor}</p>`,
    tx,
  );

// Lady Stretch: светлое письмо (решение владельца 2026-10-15: тёмное —
// «мрачно»). Подложка — светло-серая, карточка белая, шапка карточки —
// тёмно-серая, как боковое меню админки #1a2027, с белым логотипом; текст и
// цифры кода — тот же серый, код — на бледно-розовой плашке с розовой
// рамкой бренда #f763fc. Вёрстка таблицами с bgcolor: почтовик, срезавший
// фон у div (Outlook), иначе потерял бы тёмную шапку. Логотип — картинка с
// админки (public/email/, белый на тёмном), без неё — подпись alt белым.
const LS_PINK = "#f763fc";
const LS_PINK_SOFT = "#fef0fe";
const LS_INK = "#1a2027";
const LS_PAGE = "#f4f4f6";
const LS_MUTED = "#5f6873";
const LS_FAINT = "#8a929c";
// Логотип — с портала (ADMIN_APP_URL) или EMAIL_LOGO_URL.
const lsLogoUrl = () =>
  process.env.EMAIL_LOGO_URL?.trim() ||
  `${(process.env.ADMIN_APP_URL ?? "").replace(/\/+$/, "")}/email/lady-stretch-logo-dark.png`;

const codeLadyStretch = (title: string, lead: string, token: string, tx: EmailTexts) => `
<div style="margin:0;padding:0;background:${LS_PAGE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LS_PAGE}" style="background:${LS_PAGE};font-family:Roboto,Arial,Helvetica,sans-serif">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:440px">
      <tr><td align="center" bgcolor="${LS_INK}" style="background:${LS_INK};border-radius:20px 20px 0 0;padding:22px 16px">
        <img src="${lsLogoUrl()}" width="140" height="40" alt="Lady Stretch" style="display:block;width:140px;height:40px;border:0;color:#ffffff;font-size:22px;font-weight:600">
      </td></tr>
      <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 20px 20px;padding:32px 28px">
        <h2 style="margin:0;font-size:20px;font-weight:600;line-height:1.3;color:${LS_INK}">${title}</h2>
        <p style="margin:12px 0 0;color:${LS_MUTED};font-size:15px;line-height:1.5">${lead}</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0">
          <tr><td align="center" bgcolor="${LS_PINK_SOFT}" style="background:${LS_PINK_SOFT};border:1px solid ${LS_PINK};border-radius:16px;padding:18px 8px">
            <span style="font-size:36px;font-weight:700;letter-spacing:10px;padding-left:10px;color:${LS_INK}">${token}</span>
          </td></tr>
        </table>
        <p style="margin:0;color:${LS_MUTED};font-size:13px;line-height:1.5">${tx.validForPrivate}</p>
      </td></tr>
      <tr><td align="center" style="padding:24px 8px 0;color:${LS_FAINT};font-size:12px;line-height:1.5">
        ${tx.ignore}<br>
        <span style="color:${LS_PINK}">&#9679;</span>&nbsp; ${brandName("ladyStretch")}
      </td></tr>
    </table>
  </td></tr>
</table>
</div>`;

type CodeEmail = (title: string, lead: string, token: string, tx: EmailTexts) => string;

const CODE_EMAIL: Record<EmailBrand, CodeEmail> = {
  base40: codeBase40,
  ladyStretch: codeLadyStretch,
};

export type OutgoingEmail = { to: string; subject: string; html: string };

/**
 * Все письма, которые нужно отправить по одному вызову хука.
 *
 * Обычно это одно письмо на user.email. Исключение — смена почты: код нужен
 * НОВОМУ адресу (user.new_email), а при включённой Secure Email Change —
 * обоим: текущему адресу token, новому token_new (см. документацию Supabase
 * Send Email Hook; имена token_hash/token_hash_new там перепутаны намеренно,
 * на суффикс _new не полагаемся). Раньше код уходил только на старый адрес,
 * и подтвердить новую почту было нечем.
 */
export function buildEmails(
  payload: HookPayload,
  fromAdminApp: boolean,
  brand: EmailBrand = "base40",
): OutgoingEmail[] {
  const { user, email_data } = payload;
  const b: EmailBrand = fromAdminApp ? portalBrand() : brand;
  const tx = TEXTS[emailLocale(payload, fromAdminApp)];
  const codeEmail = CODE_EMAIL[b];
  if (email_data.email_action_type === "email_change") {
    const newEmail = user.new_email || null;
    if (email_data.token_new && newEmail) {
      const subject = tx.emailChangeSubject(brandName(b));
      return [
        {
          to: user.email,
          subject,
          html: codeEmail(tx.emailChangeTitle, tx.emailChangeOldLead, email_data.token, tx),
        },
        {
          to: newEmail,
          subject,
          html: codeEmail(tx.emailChangeTitle, tx.emailChangeNewLead, email_data.token_new, tx),
        },
      ];
    }
    return [{ to: newEmail ?? user.email, ...buildEmail(payload, fromAdminApp, brand) }];
  }
  return [{ to: user.email, ...buildEmail(payload, fromAdminApp, brand) }];
}

export function buildEmail(
  payload: HookPayload,
  fromAdminApp: boolean,
  brand: EmailBrand = "base40",
): { subject: string; html: string } {
  const { token, email_action_type } = payload.email_data;
  // Портал (админка) — всегда бренд портала, какой бы бренд ни передали.
  const b: EmailBrand = fromAdminApp ? portalBrand() : brand;
  const name = brandName(b);
  const tx = TEXTS[emailLocale(payload, fromAdminApp)];
  const code = (title: string, lead: string) => CODE_EMAIL[b](title, lead, token, tx);

  switch (email_action_type) {
    case "signup":
      // Саморегистрации нет: учётную запись клиента GoTrue создаёт при первом
      // входе в клиентское приложение, и только по карточке клиента с портала
      // (db/migrations/…_client_signin_only.sql). В админке shouldCreateUser:
      // false, сотрудников заводит владелец.
      return {
        subject: tx.codeSubject(name),
        html: code(tx.welcomeTitle(name), tx.codeLead),
      };
    // Вход — всегда код, в обоих приложениях. Ссылки авто-входа в письме
    // нет: её можно переслать или открыть превью почтовика, а код вводится
    // только вручную на странице входа. Приложение меняет лишь текст.
    case "magiclink":
      return fromAdminApp
        ? {
            subject: `Код для входа в портал ${name}`,
            html: code(
              "Вход в портал",
              "Введите этот код на странице входа в портал. Никому его не сообщайте.",
            ),
          }
        : {
            subject: tx.signInSubject(name),
            html: code(tx.signInTitle(name), tx.signInLead),
          };
    // Восстановления и приглашений ни одно приложение не запрашивает (паролей
    // нет ни у кого, сотрудников создаёт админка), но /recover у GoTrue
    // публичный — кто угодно может вызвать его на чужую почту. Поэтому и тут
    // код, а не ссылка: в письмах авторизации ссылок авто-входа нет вовсе.
    case "recovery":
      return {
        subject: tx.recoverySubject(name),
        html: code(tx.recoveryTitle, tx.recoveryLead),
      };
    case "invite":
      return {
        subject: tx.inviteSubject(name),
        html: code(tx.inviteTitle(name), tx.inviteLead),
      };
    case "email_change":
      return {
        subject: tx.emailChangeSubject(name),
        html: code(tx.emailChangeTitle, tx.emailChangeNewLead),
      };
    default:
      // reauthentication и будущие типы: код — универсальный запасной вариант.
      return {
        subject: tx.codeSubject(name),
        html: code(tx.confirmTitle, tx.codeLead),
      };
  }
}

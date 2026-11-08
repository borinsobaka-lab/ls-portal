/**
 * Письмо-уведомление портала (решение владельца 2026-11-08): то же, что
 * пуш, — заголовок, текст и кнопка «Открыть в портале», внизу — ссылка на
 * настройки уведомлений. Вид — светлое письмо портала, как письма входа
 * (lib/auth-email.ts: светло-серая подложка, белая карточка с тёмной шапкой
 * цвета меню и надписью бренда). Вёрстка таблицами с bgcolor — почтовики
 * срезают фон у div. Всё, что пришло из базы, экранируется. Тест —
 * notifications.test.ts.
 */
import { brandName, portalBrand } from "@/lib/auth-email";
import { NOTIF_KIND_BY_KEY } from "./kinds";

type Env = Record<string, string | undefined>;

export type PortalEmailRow = {
  kind: string;
  title: string;
  body: string | null;
  url: string | null;
  user_name: string | null;
};

export type PortalEmail = { subject: string; html: string; text: string };

const PINK = "#f763fc";
const INK = "#1a2027";
const PAGE = "#f4f4f6";
const MUTED = "#5f6873";
const FAINT = "#8a929c";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Адрес портала без «/» в конце (ADMIN_APP_URL); нет — ссылок в письме нет. */
export function portalOrigin(env: Env = process.env): string | null {
  const raw = env.ADMIN_APP_URL?.trim().replace(/\/+$/, "");
  return raw && /^https?:\/\//.test(raw) ? raw : null;
}

/** Полная ссылка на путь портала; внешние адреса не проходят. */
export function portalLink(path: string | null, env: Env = process.env): string | null {
  const origin = portalOrigin(env);
  if (!origin) return null;
  const p = path && path.startsWith("/") && !path.startsWith("//") ? path : "/notifications";
  return origin + p;
}

function header(env: Env): string {
  const brand = portalBrand(env);
  const name = escapeHtml(brandName(brand, env));
  if (brand === "ladyFitPro" && name === "LadyFitPro") {
    return (
      `<span style="display:inline-block;font-size:24px;line-height:36px;font-weight:700;letter-spacing:0.02em;color:#ffffff">` +
      `LadyFit<span style="color:${PINK}">Pro</span></span>`
    );
  }
  return `<span style="display:inline-block;font-size:22px;line-height:36px;font-weight:700;color:#ffffff">${name}</span>`;
}

/** Текст уведомления: переносы строк — как в пуше. */
function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

export function buildPortalEmail(row: PortalEmailRow, env: Env = process.env): PortalEmail {
  const brand = brandName(portalBrand(env), env);
  const title = row.title.trim() || "Уведомление";
  const kindLabel = NOTIF_KIND_BY_KEY.get(row.kind)?.label ?? null;
  const subject = `${title} — ${brand}`.slice(0, 250);
  const open = portalLink(row.url, env);
  const settings = portalLink("/notifications/settings", env);
  const greeting = row.user_name ? `${escapeHtml(row.user_name)}, ` : "";

  const html = `
<div style="margin:0;padding:0;background:${PAGE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE};font-family:Roboto,Arial,Helvetica,sans-serif">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
      <tr><td align="center" bgcolor="${INK}" style="background:${INK};border-radius:20px 20px 0 0;padding:18px 16px">
        ${header(env)}
      </td></tr>
      <tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:0 0 20px 20px;padding:28px">
        ${kindLabel ? `<p style="margin:0 0 8px;color:${FAINT};font-size:12px;line-height:1.4;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(kindLabel)}</p>` : ""}
        <h2 style="margin:0;font-size:20px;font-weight:600;line-height:1.3;color:${INK}">${escapeHtml(title)}</h2>
        ${row.body ? `<p style="margin:12px 0 0;color:${MUTED};font-size:15px;line-height:1.5">${paragraphs(row.body)}</p>` : ""}
        ${
          open
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0">
          <tr><td bgcolor="${INK}" style="background:${INK};border-radius:999px">
            <a href="${escapeHtml(open)}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Открыть в портале</a>
          </td></tr>
        </table>`
            : ""
        }
      </td></tr>
      <tr><td align="center" style="padding:20px 8px 0;color:${FAINT};font-size:12px;line-height:1.5">
        ${greeting}это письмо пришло, потому что уведомления этого вида у вас включены на почту.${
          settings
            ? `<br><a href="${escapeHtml(settings)}" style="color:${FAINT};text-decoration:underline">Настроить уведомления</a>`
            : ""
        }<br>
        <span style="color:${PINK}">&#9679;</span>&nbsp; ${escapeHtml(brand)}
      </td></tr>
    </table>
  </td></tr>
</table>
</div>`;

  const text = [
    kindLabel,
    title,
    row.body,
    open ? `Открыть в портале: ${open}` : null,
    "",
    "Это письмо пришло, потому что уведомления этого вида у вас включены на почту.",
    settings ? `Настроить уведомления: ${settings}` : null,
  ]
    .filter((v): v is string => v !== null)
    .join("\n");

  return { subject, html, text };
}

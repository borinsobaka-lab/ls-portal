/**
 * Шлюз Telegram для «Аналитика» → «VK Ads» → «Контроль бюджетов» —
 * Cloudflare Worker (DEPLOY.md, «Аналитика», шаг 9). С сервера в России
 * api.telegram.org бывает недоступен; портал шлёт запросы Bot API сюда, а
 * Worker — в Telegram.
 *
 * Запрос портала: POST https://<worker>.workers.dev/<метод>, заголовок
 * `Authorization: Bearer <GATEWAY_SECRET>`, тело — как у Bot API
 * (application/x-www-form-urlencoded). Ответ Telegram возвращается как есть.
 * Разрешены только методы портала: getMe, getUpdates, sendMessage.
 *
 * Secrets Worker (Settings → Variables and Secrets, тип Secret):
 * TELEGRAM_BOT_TOKEN — токен бота из BotFather; GATEWAY_SECRET — не короче
 * 24 символов (`openssl rand -hex 24`), тот же — в портале. Значения в
 * репозиторий не попадают.
 */
const METHODS = new Set(["getMe", "getUpdates", "sendMessage"]);

const json = (body, status) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Сравнение без утечки по времени: SHA-256 обеих строк и XOR байтов. */
async function same(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i] ^ v[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const method = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");
    if (request.method !== "POST" || !METHODS.has(method)) {
      return json({ ok: false, description: "Not Found" }, 404);
    }
    const secret = env.GATEWAY_SECRET || "";
    const auth = request.headers.get("Authorization") || "";
    if (secret.length < 24 || !env.TELEGRAM_BOT_TOKEN || !(await same(auth, `Bearer ${secret}`))) {
      return json({ ok: false, description: "Unauthorized" }, 401);
    }
    let res;
    try {
      res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: await request.text(),
      });
    } catch {
      return json({ ok: false, description: "Telegram недоступен из шлюза" }, 502);
    }
    return new Response(await res.text(), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  },
};

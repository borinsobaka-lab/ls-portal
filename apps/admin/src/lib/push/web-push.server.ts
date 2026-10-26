/**
 * Отправка Web Push без сторонних сервисов и библиотек — только WebCrypto и
 * fetch (сервер админки работает на Bun):
 *
 * - шифрование содержимого — RFC 8291 (aes128gcm, ECDH P-256 + HKDF): пуш
 *   читает только устройство, служба доставки видит лишь шифротекст;
 * - подпись VAPID — RFC 8292 (JWT ES256): служба доставки (Google, Apple,
 *   Mozilla) пускает пуш только с ключом, на который подписано устройство.
 *
 * Проверка — web-push.test.ts (пример из RFC 8291, расшифровка, подпись).
 * Очередь и рассылка — push-worker.server.ts.
 */

type Bytes = Uint8Array<ArrayBuffer>;

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

/** Размер записи aes128gcm: одна запись на пуш (предел содержимого — payload.ts). */
const RECORD_SIZE = 4096;
/** Токен VAPID живёт 12 часов (Apple — не больше суток), обновляем за час. */
const VAPID_TTL_SECONDS = 12 * 60 * 60;
const VAPID_REFRESH_SECONDS = 60 * 60;

export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

export function concat(...parts: (Uint8Array | number[])[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url (и обычный base64 — так ключи отдают некоторые браузеры). */
export function b64urlDecode(text: string): Bytes {
  const b64 = text.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

export type EncryptOptions = {
  /** Только для тестов: соль и ключ сервера из примера RFC 8291. */
  salt?: Bytes;
  serverKeys?: CryptoKeyPair;
};

/**
 * Шифрует содержимое пуша для устройства (ключи подписки p256dh и auth из
 * PushSubscription). Возвращает тело запроса к службе доставки
 * (Content-Encoding: aes128gcm).
 */
export async function encryptPayload(
  plaintext: Bytes,
  p256dh: string,
  authSecret: string,
  options: EncryptOptions = {},
): Promise<Bytes> {
  const uaPublic = b64urlDecode(p256dh);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("Неверный ключ p256dh");
  const auth = b64urlDecode(authSecret);
  if (auth.length < 16) throw new Error("Неверный ключ auth");
  if (plaintext.length > RECORD_SIZE - 17) throw new Error("Слишком длинное содержимое пуша");

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const serverKeys =
    options.serverKeys ??
    ((await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array(await subtle.exportKey("raw", serverKeys.publicKey));
  const uaKey = await subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await subtle.deriveBits({ name: "ECDH", public: uaKey }, serverKeys.privateKey, 256),
  );

  // RFC 8291, раздел 3.4: ключ из общего секрета и auth устройства…
  const prkKey = await hmac(auth, ecdhSecret);
  const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hmac(prkKey, concat(keyInfo, [1]));
  // …и RFC 8188: ключ и nonce записи из соли.
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(utf8("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(utf8("Content-Encoding: nonce\0"), [1]))).slice(0, 12);

  const cekKey = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // Одна (последняя) запись: разделитель 0x02 без дополнения.
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, concat(plaintext, [2])),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---- VAPID ------------------------------------------------------------------

export type VapidKeyPair = {
  /** base64url несжатой точки P-256 — applicationServerKey подписки. */
  publicKey: string;
  /** Закрытый ключ ECDSA P-256 в JWK (хранится в push_vapid_keys). */
  privateJwk: JsonWebKey;
};

export async function generateVapidKeys(): Promise<VapidKeyPair> {
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return {
    publicKey: b64urlEncode(raw),
    privateJwk: await subtle.exportKey("jwk", pair.privateKey),
  };
}

/**
 * Заголовок Authorization для службы доставки. Токен подписывается один раз
 * на службу (aud — её адрес) и живёт 12 часов: на рассылку тысяч пушей —
 * несколько подписей.
 */
export class VapidSigner {
  private readonly cache = new Map<string, { header: string; refreshAt: number }>();
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(
    private readonly keys: VapidKeyPair,
    /** mailto: или https: — Apple без него отклоняет пуши. */
    private readonly subject: string,
  ) {}

  private privateKey(): Promise<CryptoKey> {
    // Только d, x, y: у экспортированного JWK бывают key_ops/ext, которые
    // мешают импорту в другой среде.
    const { kty, crv, d, x, y } = this.keys.privateJwk;
    this.keyPromise ??= subtle.importKey(
      "jwk",
      { kty, crv, d, x, y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return this.keyPromise;
  }

  async authorization(endpoint: string, now = Date.now()): Promise<string> {
    const aud = new URL(endpoint).origin;
    const nowSec = Math.floor(now / 1000);
    const hit = this.cache.get(aud);
    if (hit && hit.refreshAt > nowSec) return hit.header;

    const exp = nowSec + VAPID_TTL_SECONDS;
    const head = b64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64urlEncode(utf8(JSON.stringify({ aud, exp, sub: this.subject })));
    const unsigned = `${head}.${claims}`;
    // WebCrypto отдаёт подпись ECDSA как r||s (64 байта) — то, что нужно JWS.
    const signature = new Uint8Array(
      await subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        await this.privateKey(),
        utf8(unsigned),
      ),
    );
    const header = `vapid t=${unsigned}.${b64urlEncode(signature)}, k=${this.keys.publicKey}`;
    this.cache.set(aud, { header, refreshAt: exp - VAPID_REFRESH_SECONDS });
    return header;
  }
}

// ---- Адреса служб и отправка ------------------------------------------------

/**
 * Службы доставки браузеров — тот же список, что push_endpoint_allowed в
 * базе (db/migrations/2026-10-15_push_delivery.sql). Чужой адрес не трогаем.
 */
const PUSH_HOST_SUFFIXES = [
  "googleapis.com",
  "push.apple.com",
  "mozilla.com",
  "mozaws.net",
  "notify.windows.com",
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export type PushOutcome = "sent" | "retry" | "failed" | "gone";

/** Ответ службы доставки → что делать с доставкой. */
export function classifyPushStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "sent";
  // Подписки больше нет: приложение удалено, уведомления выключены.
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  // 400/401/403/413 — не повторять. 403 — не «gone»: так отвечают и на
  // ошибку подписи VAPID, а удалять из-за неё все подписки нельзя.
  return "failed";
}

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

export type SendOptions = {
  /** Сколько служба держит пуш для выключенного телефона, с. */
  ttl?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type SendResult = { outcome: PushOutcome; error?: string };

export async function sendWebPush(
  target: PushTarget,
  payload: string,
  signer: VapidSigner,
  options: SendOptions = {},
): Promise<SendResult> {
  if (!isAllowedPushEndpoint(target.endpoint)) {
    return { outcome: "gone", error: "Неизвестная служба доставки" };
  }
  let body: Bytes;
  try {
    body = await encryptPayload(utf8(payload), target.p256dh, target.auth);
  } catch (e) {
    // Битые ключи подписки — устройство не прочтёт ни один пуш.
    return { outcome: "gone", error: e instanceof Error ? e.message : String(e) };
  }
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: await signer.authorization(target.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(options.ttl ?? 2 * 24 * 60 * 60),
        Urgency: "normal",
      },
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const outcome = classifyPushStatus(response.status);
    if (outcome === "sent") return { outcome };
    const text = (await response.text().catch(() => "")).slice(0, 300);
    return { outcome, error: `${response.status} ${text}`.trim() };
  } catch (e) {
    // Сеть, таймаут — попробуем ещё раз со следующей пачкой.
    return { outcome: "retry", error: e instanceof Error ? e.message : String(e) };
  }
}

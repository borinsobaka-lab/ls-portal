import { describe, expect, test } from "bun:test";

import {
  VapidSigner,
  b64urlDecode,
  b64urlEncode,
  classifyPushStatus,
  concat,
  encryptPayload,
  generateVapidKeys,
  isAllowedPushEndpoint,
  sendWebPush,
  utf8,
} from "./web-push.server";

const subtle = crypto.subtle;

/** Пример из RFC 8291, приложение A. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** Пара ECDH P-256 из открытого (несжатая точка) и закрытого ключа. */
async function importEcdhPair(publicB64: string, privateB64: string): Promise<CryptoKeyPair> {
  const pub = b64urlDecode(publicB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: privateB64,
  };
  const algorithm = { name: "ECDH", namedCurve: "P-256" };
  return {
    publicKey: await subtle.importKey("raw", pub, algorithm, true, []),
    privateKey: await subtle.importKey("jwk", jwk, algorithm, true, ["deriveBits"]),
  };
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}

/** Расшифровка на стороне устройства (RFC 8291) — независимо от encryptPayload. */
async function decrypt(body: Uint8Array<ArrayBuffer>, ua: CryptoKeyPair, authB64: string) {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  expect(rs).toBe(4096);

  const asKey = await subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const secret = new Uint8Array(
    await subtle.deriveBits({ name: "ECDH", public: asKey }, ua.privateKey, 256),
  );
  const uaPublic = new Uint8Array(await subtle.exportKey("raw", ua.publicKey));
  const prkKey = await hmac(b64urlDecode(authB64), secret);
  const ikm = await hmac(prkKey, concat(utf8("WebPush: info\0"), uaPublic, asPublic, [1]));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(utf8("Content-Encoding: aes128gcm\0"), [1]))).slice(0, 16);
  const nonce = (await hmac(prk, concat(utf8("Content-Encoding: nonce\0"), [1]))).slice(0, 12);
  const key = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(
    await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
  );
  // Последняя запись: содержимое, 0x02, нули.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  expect(padded[end]).toBe(2);
  return new TextDecoder().decode(padded.slice(0, end));
}

describe("шифрование пуша (RFC 8291)", () => {
  test("пример из RFC 8291 — байт в байт", async () => {
    const body = await encryptPayload(utf8(RFC.plaintext), RFC.uaPublic, RFC.auth, {
      salt: b64urlDecode(RFC.salt),
      serverKeys: await importEcdhPair(RFC.asPublic, RFC.asPrivate),
    });
    expect(b64urlEncode(body)).toBe(RFC.message);
  });

  test("устройство расшифровывает пуш (русский и грузинский текст)", async () => {
    const ua = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const p256dh = b64urlEncode(new Uint8Array(await subtle.exportKey("raw", ua.publicKey)));
    const auth = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const text = JSON.stringify({ t: "Скидка 20%", b: "ფასდაკლება 20% ✨" });
    const body = await encryptPayload(utf8(text), p256dh, auth);
    expect(await decrypt(body, ua, auth)).toBe(text);
    // Каждый пуш — своя соль и свой ключ сервера.
    const again = await encryptPayload(utf8(text), p256dh, auth);
    expect(b64urlEncode(again)).not.toBe(b64urlEncode(body));
  });

  test("битые ключи подписки и слишком длинное содержимое — ошибка", async () => {
    await expect(encryptPayload(utf8("x"), "AAAA", RFC.auth)).rejects.toThrow("p256dh");
    await expect(encryptPayload(utf8("x"), RFC.uaPublic, "AAAA")).rejects.toThrow("auth");
    await expect(encryptPayload(new Uint8Array(5000), RFC.uaPublic, RFC.auth)).rejects.toThrow(
      "длинное",
    );
  });
});

describe("VAPID (RFC 8292)", () => {
  test("токен подписан ключом, aud — адрес службы, кэш на службу", async () => {
    const keys = await generateVapidKeys();
    expect(b64urlDecode(keys.publicKey).length).toBe(65);
    const signer = new VapidSigner(keys, "mailto:noreply@base40.fit");
    const now = Date.UTC(2026, 9, 15, 12);
    const header = await signer.authorization("https://web.push.apple.com/QGabc", now);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(head)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(new TextDecoder().decode(b64urlDecode(claims)))).toEqual({
      aud: "https://web.push.apple.com",
      exp: now / 1000 + 12 * 3600,
      sub: "mailto:noreply@base40.fit",
    });
    const sig = b64urlDecode(signature);
    expect(sig.length).toBe(64);
    const pub = await subtle.importKey(
      "raw",
      b64urlDecode(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, utf8(`${head}.${claims}`)),
    ).toBe(true);

    // Та же служба — тот же токен; другая — свой.
    expect(await signer.authorization("https://web.push.apple.com/other", now + 1000)).toBe(header);
    expect(await signer.authorization("https://fcm.googleapis.com/fcm/send/x", now)).not.toBe(
      header,
    );
    // За час до конца — новый.
    expect(
      await signer.authorization("https://web.push.apple.com/QGabc", now + 11.5 * 3600 * 1000),
    ).not.toBe(header);
  });
});

describe("адреса служб и ответы", () => {
  test("только службы браузеров", () => {
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isAllowedPushEndpoint("https://web.push.apple.com/QGabc")).toBe(true);
    expect(isAllowedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(
      true,
    );
    expect(isAllowedPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isAllowedPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com.evil.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://evilgoogleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isAllowedPushEndpoint("https://user@fcm.googleapis.com/x")).toBe(false);
    expect(isAllowedPushEndpoint("not a url")).toBe(false);
  });

  test("ответ службы → итог доставки", () => {
    expect(classifyPushStatus(201)).toBe("sent");
    expect(classifyPushStatus(404)).toBe("gone");
    expect(classifyPushStatus(410)).toBe("gone");
    expect(classifyPushStatus(429)).toBe("retry");
    expect(classifyPushStatus(503)).toBe("retry");
    expect(classifyPushStatus(400)).toBe("failed");
    expect(classifyPushStatus(403)).toBe("failed");
    expect(classifyPushStatus(413)).toBe("failed");
  });

  test("запрос к службе: заголовки, тело, итог", async () => {
    const ua = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const target = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      p256dh: b64urlEncode(new Uint8Array(await subtle.exportKey("raw", ua.publicKey))),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
    const signer = new VapidSigner(await generateVapidKeys(), "mailto:noreply@base40.fit");
    let seen: { url: string; init: RequestInit } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;

    const result = await sendWebPush(target, '{"t":"Привет"}', signer, {
      fetch: fakeFetch,
      ttl: 60,
    });
    expect(result).toEqual({ outcome: "sent" });
    expect(seen!.url).toBe(target.endpoint);
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("60");
    expect(headers.Authorization).toStartWith("vapid t=");
    expect(await decrypt(seen!.init.body as Uint8Array<ArrayBuffer>, ua, target.auth)).toBe(
      '{"t":"Привет"}',
    );

    const gone = (async () => new Response("expired", { status: 410 })) as unknown as typeof fetch;
    expect(await sendWebPush(target, "{}", signer, { fetch: gone })).toEqual({
      outcome: "gone",
      error: "410 expired",
    });
    const offline = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await sendWebPush(target, "{}", signer, { fetch: offline })).toEqual({
      outcome: "retry",
      error: "network down",
    });
    expect(
      await sendWebPush({ ...target, endpoint: "https://evil.example/x" }, "{}", signer, {
        fetch: fakeFetch,
      }),
    ).toEqual({ outcome: "gone", error: "Неизвестная служба доставки" });
  });
});

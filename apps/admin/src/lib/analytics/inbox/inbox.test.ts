import { describe, expect, test } from "bun:test";

import {
  INBOX_TEXT,
  InboxError,
  firstHistoryTimestamp,
  inboxCallbackParse,
  inboxCallbackUrl,
  inboxDisplayName,
  inboxProfileUpdates,
  inboxSecretValid,
  normalizeVkCommunityId,
  pyInt,
  pyStr,
  pyTruthy,
  vkCommunityRef,
  vkGroupFromResponse,
  vkMethodResponse,
} from "./rules";

describe("ID группы (их normalize_vk_community_id / resolve_vk_community)", () => {
  test("число, public и club, минус впереди", () => {
    expect(normalizeVkCommunityId(" 216469945 ")).toBe(216469945);
    expect(normalizeVkCommunityId("-216469945")).toBe(216469945);
    expect(normalizeVkCommunityId("https://vk.ru/public123456")).toBe(123456);
    expect(normalizeVkCommunityId("vk.com/CLUB77/")).toBe(77);
    expect(normalizeVkCommunityId("club77?w=wall")).toBe(77);
  });
  test("не число — их текст", () => {
    expect(() => normalizeVkCommunityId("vk.ru/ladystretch")).toThrow(INBOX_TEXT.badId);
    expect(() => normalizeVkCommunityId("public12x")).toThrow(InboxError);
    expect(() => normalizeVkCommunityId("")).toThrow(InboxError);
    // У них 20 цифр проходили и падали в базе — здесь ошибка сразу, без запроса VK.
    expect(() => vkCommunityRef("99999999999999999999", "t")).toThrow(INBOX_TEXT.idTooLarge);
  });
  test("короткий адрес — для groups.getById, нужен токен", () => {
    expect(vkCommunityRef("123", "")).toEqual({ id: 123 });
    expect(vkCommunityRef("https://www.vk.com/ladystretch_penza/", "t")).toEqual({
      shortName: "ladystretch_penza",
    });
    expect(vkCommunityRef("vk.ru/lady.stretch-1?from=x", "t")).toEqual({
      shortName: "lady.stretch-1",
    });
    expect(vkCommunityRef("ladystretch_penza", "t")).toEqual({ shortName: "ladystretch_penza" });
    expect(() => vkCommunityRef("ladystretch_penza", "  ")).toThrow(INBOX_TEXT.needToken);
    expect(() => vkCommunityRef("https://ok.ru/group", "t")).toThrow(INBOX_TEXT.badShortName);
    expect(() => vkCommunityRef("x", "t")).toThrow(INBOX_TEXT.badShortName);
  });
  test("ответ groups.getById: v5.199 и старый список, ошибки", () => {
    expect(vkGroupFromResponse({ response: { groups: [{ id: 5, name: "Группа" }] } })).toEqual({
      id: 5,
      name: "Группа",
    });
    expect(vkGroupFromResponse({ response: [{ id: "7" }] })).toEqual({ id: 7, name: "" });
    expect(() => vkGroupFromResponse({ error: { error_msg: "Access denied" } })).toThrow(
      "VK не подтвердил группу: Access denied",
    );
    expect(() => vkGroupFromResponse({ error: { error_code: 5 } })).toThrow(
      "VK не подтвердил группу: неизвестная ошибка",
    );
    expect(() => vkGroupFromResponse({ response: { groups: [] } })).toThrow(
      INBOX_TEXT.resolveNoGroup,
    );
    expect(() => vkGroupFromResponse({ response: [{ id: "abc" }] })).toThrow(
      INBOX_TEXT.resolveNoGroup,
    );
  });
  test("название из VK заменяет введённое, если отличается", () => {
    expect(inboxDisplayName("lady stretch тула", "Lady Stretch Тула")).toBe("lady stretch тула");
    expect(inboxDisplayName("Тула", "Lady Stretch Тула")).toBe("Lady Stretch Тула");
    expect(inboxDisplayName("Тула", "")).toBe("Тула");
  });
});

describe("Python-приведения", () => {
  test("int()", () => {
    expect(pyInt(12.9)).toBe(12);
    expect(pyInt(-12.9)).toBe(-12);
    expect(pyInt(true)).toBe(1);
    expect(pyInt(" 1_000 ")).toBe(1000);
    expect(pyInt("-5")).toBe(-5);
    expect(() => pyInt("1.5")).toThrow();
    expect(() => pyInt(null)).toThrow();
    expect(() => pyInt([1])).toThrow();
  });
  test("bool() и str()", () => {
    expect([0, "", null, [], {}, false].map(pyTruthy)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect([1, "0", [0], { a: 1 }, true].map(pyTruthy)).toEqual([true, true, true, true, true]);
    expect([null, true, false, 5, "x"].map(pyStr)).toEqual(["None", "True", "False", "5", "x"]);
  });
});

describe("событие Callback API (их handle_callback / _store_message)", () => {
  const now = 1761900000.7;
  test("не словарь — их ошибка", () => {
    expect(() => inboxCallbackParse([1], now)).toThrow(INBOX_TEXT.badEvent);
    expect(() => inboxCallbackParse(null, now)).toThrow(INBOX_TEXT.badEvent);
  });
  test("подтверждение: без секрета и сообщения", () => {
    expect(inboxCallbackParse({ type: "confirmation", group_id: 1 }, now)).toEqual({
      type: "confirmation",
      secret: "",
      message: null,
    });
  });
  test("message_new: сообщение в object.message, входящее", () => {
    const r = inboxCallbackParse(
      {
        type: "message_new",
        secret: "s",
        object: { message: { id: 10, peer_id: 5, from_id: 5, date: 100, text: "Привет" } },
      },
      now,
    );
    expect(r.secret).toBe("s");
    expect(r.message).toMatchObject({
      peer_id: 5,
      id: 10,
      date: 100,
      from_id: 5,
      out: false,
      conversation_message_id: null,
      text: "Привет",
    });
  });
  test("message_reply / message_edit: сообщение — сам object", () => {
    const r = inboxCallbackParse(
      {
        type: "message_reply",
        object: { id: "11", peer_id: 5, out: 1, from_id: -9, conversation_message_id: 3 },
      },
      now,
    );
    expect(r.message).toMatchObject({ id: 11, out: true, from_id: -9, conversation_message_id: 3 });
    // date нет — время приёма; text нет — ''.
    expect(r.message?.date).toBe(1761900000);
    expect(r.message?.text).toBe("");
  });
  test("без peer_id / id — пропуск; плохая дата — ошибка", () => {
    expect(
      inboxCallbackParse({ type: "message_new", object: { message: { id: 1 } } }, now).message,
    ).toBeNull();
    expect(
      inboxCallbackParse(
        { type: "message_new", object: { message: { id: 1, peer_id: null } } },
        now,
      ).message,
    ).toBeNull();
    expect(() =>
      inboxCallbackParse(
        { type: "message_new", object: { message: { id: 1, peer_id: 2, date: "x" } } },
        now,
      ),
    ).toThrow(INBOX_TEXT.badEvent);
  });
  test("message: null — пропуск; прочие типы — без сообщения; секрет null — 'None'", () => {
    expect(
      inboxCallbackParse({ type: "message_new", object: { message: null } }, now).message,
    ).toBeNull();
    expect(
      inboxCallbackParse({ type: "group_join", object: { id: 1, peer_id: 2 } }, now).message,
    ).toBeNull();
    expect(inboxCallbackParse({ type: "message_new", secret: null }, now).secret).toBe("None");
  });
  test("from_id 0 — нет отправителя; текст null — 'None'", () => {
    const r = inboxCallbackParse(
      { type: "message_new", object: { message: { id: 1, peer_id: 2, from_id: 0, text: null } } },
      now,
    );
    expect(r.message?.from_id).toBeNull();
    expect(r.message?.text).toBe("None");
  });
});

describe("первое сообщение (их first_history_timestamp)", () => {
  const local = new Date("2026-10-01T00:00:00Z");
  const ok = { count: 5, items: [{ peer_id: 7, date: 1759000000 }] };
  test("дата самого раннего сообщения", () => {
    expect(firstHistoryTimestamp(ok, 7, local).toISOString()).toBe(
      new Date(1759000000 * 1000).toISOString(),
    );
  });
  test("их проверки", () => {
    expect(() => firstHistoryTimestamp({ count: 0, items: [] }, 7, local)).toThrow(
      INBOX_TEXT.noHistory,
    );
    expect(() => firstHistoryTimestamp({ count: 1.5, items: [] }, 7, local)).toThrow(
      INBOX_TEXT.noHistory,
    );
    expect(() => firstHistoryTimestamp({ count: 2, items: [] }, 7, local)).toThrow(
      INBOX_TEXT.noFirst,
    );
    expect(() =>
      firstHistoryTimestamp({ count: 2, items: [{ peer_id: 8, date: 1 }] }, 7, local),
    ).toThrow(INBOX_TEXT.notConfirmed);
    expect(() =>
      firstHistoryTimestamp(
        { count: 2, items: [{ peer_id: 7, date: 1, action: { type: "x" } }] },
        7,
        local,
      ),
    ).toThrow(INBOX_TEXT.notConfirmed);
    expect(() =>
      firstHistoryTimestamp({ count: 2, items: [{ peer_id: 7, date: 1800000000 }] }, 7, local),
    ).toThrow(INBOX_TEXT.laterThanLocal);
  });
});

describe("имена и аватарки (их refresh_missing_customer_profiles)", () => {
  const batch = [
    { id: 1, customer_vk_id: 10, community_id: 1, has_name: false, has_avatar: false },
    { id: 2, customer_vk_id: 20, community_id: 1, has_name: true, has_avatar: false },
    { id: 3, customer_vk_id: 30, community_id: 1, has_name: false, has_avatar: true },
    { id: 4, customer_vk_id: 40, community_id: 1, has_name: true, has_avatar: true },
  ];
  test("только пустые поля, только https", () => {
    const users = [
      { id: 10, first_name: " Анна ", last_name: "Иванова", photo_100: "https://a/1.jpg" },
      { id: 20, first_name: "Олег", photo_100: "http://a/2.jpg" },
      { id: 30, first_name: "", last_name: "", photo_100: "https://a/3.jpg" },
      { id: 40, first_name: "Мария", photo_100: "https://a/4.jpg" },
      { id: -5, first_name: "Сообщество" },
    ];
    expect(inboxProfileUpdates(users, batch)).toEqual([
      { id: 1, name: "Анна Иванова", avatar: "https://a/1.jpg" },
    ]);
    expect(inboxProfileUpdates({ items: [{ id: "30", first_name: "Ира" }] }, batch)).toEqual([
      { id: 3, name: "Ира", avatar: "" },
    ]);
    expect(inboxProfileUpdates({ count: 1 }, batch)).toEqual([]);
  });
});

describe("прочее", () => {
  test("ответ VK-метода", () => {
    expect(vkMethodResponse({ response: [1] })).toEqual([1]);
    expect(() => vkMethodResponse({ error: { error_msg: "Flood control" } })).toThrow(
      "VK не отправил сообщение: Flood control",
    );
    expect(() => vkMethodResponse("x")).toThrow("VK не отправил сообщение: неизвестная ошибка");
  });
  test("секрет из VK — 16–256 знаков", () => {
    expect(inboxSecretValid("x".repeat(15))).toBe(false);
    expect(inboxSecretValid(` ${"x".repeat(16)} `)).toBe(true);
    expect(inboxSecretValid("x".repeat(257))).toBe(false);
  });
  test("адрес Callback API", () => {
    expect(inboxCallbackUrl("https://portal.example.ru/", 3)).toBe(
      "https://portal.example.ru/api/analytics/vk-callback/3",
    );
  });
});

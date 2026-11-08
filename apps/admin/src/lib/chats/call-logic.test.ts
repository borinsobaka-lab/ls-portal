import { describe, expect, test } from "bun:test";

import { callEndedNotice, callErrorText, callSystemText, formatCallDuration } from "./call-logic";
import {
  kinescopeErrorDetail,
  kinescopeErrorText,
  ownerFromRooms,
  parseSpeakRoom,
} from "./kinescope";

describe("видеозвонки: подписи", () => {
  test("длительность", () => {
    expect(formatCallDuration(0)).toBe("0 с");
    expect(formatCallDuration(45)).toBe("45 с");
    expect(formatCallDuration(60)).toBe("1 мин");
    expect(formatCallDuration(12 * 60 + 20)).toBe("12 мин");
    expect(formatCallDuration(65 * 60)).toBe("1 ч 5 мин");
    expect(formatCallDuration(120 * 60)).toBe("2 ч");
  });

  test("сообщение в переписке", () => {
    expect(callSystemText({ type: "call", state: "live" }, "Анна")).toBe(
      "Анна начал(а) видеозвонок",
    );
    expect(
      callSystemText({ type: "call", state: "ended", reason: "finished", duration: 300 }, "Анна"),
    ).toBe("Видеозвонок · 5 мин");
    expect(callSystemText({ type: "call", state: "ended", reason: "missed" }, "Анна")).toBe(
      "Пропущенный видеозвонок",
    );
    expect(callSystemText({ type: "call", state: "ended", reason: "declined" }, "Анна")).toBe(
      "Видеозвонок отклонён",
    );
    expect(callSystemText({ type: "call", state: "ended", reason: "failed" }, "Анна")).toBe(
      "Видеозвонок не состоялся",
    );
  });

  test("итог звонка — позвонившему", () => {
    expect(callEndedNotice("declined", "direct", true)).toBe("Собеседник отклонил звонок");
    expect(callEndedNotice("declined", "direct", false)).toBeNull();
    expect(callEndedNotice("missed", "direct", true)).toBe("Собеседник не ответил");
    expect(callEndedNotice("missed", "group", true)).toBe("Никто не ответил на звонок");
    expect(callEndedNotice("finished", "group", false)).toBe("Звонок завершён");
    expect(callEndedNotice("cancelled", "direct", true)).toBeNull();
  });

  test("ошибки", () => {
    expect(callErrorText(new Error("chat_call_disabled"))).toBe(
      "Видеозвонки не настроены на сервере",
    );
    expect(callErrorText(new Error("что-то"))).toBe("что-то");
  });
});

describe("Kinescope Speak: ответ создания комнаты", () => {
  test("id и ссылка https", () => {
    expect(
      parseSpeakRoom({
        data: { id: "r-1", link: "https://speak.kinescope.io/zqu-kqyh-ymz", code: "zqu-kqyh-ymz" },
      }),
    ).toEqual({ id: "r-1", link: "https://speak.kinescope.io/zqu-kqyh-ymz" });
  });

  test("без ссылки или не https — нет", () => {
    expect(parseSpeakRoom({ data: { id: "r-1" } })).toBeNull();
    expect(parseSpeakRoom({ data: { id: "r-1", link: "javascript:alert(1)" } })).toBeNull();
    expect(parseSpeakRoom({ data: { id: "r-1", link: "http://speak.kinescope.io/x" } })).toBeNull();
    expect(parseSpeakRoom(null)).toBeNull();
  });
});

describe("Kinescope: ошибки и владелец комнат", () => {
  test("причина отказа — в тексте окна", () => {
    expect(callErrorText(new Error("chat_call_room_failed: Kinescope отклонил запрос (400)"))).toBe(
      "Не удалось создать видеоконференцию: Kinescope отклонил запрос (400)",
    );
  });

  test("текст ошибки из ответа", () => {
    expect(
      kinescopeErrorDetail(
        '{"error":{"code":400100,"message":"bad request","details":{"owner_id":"required"}}}',
      ),
    ).toBe('bad request — {"owner_id":"required"}');
    expect(kinescopeErrorDetail("Bad Gateway")).toBe("Bad Gateway");
    expect(kinescopeErrorText(401, "Unauthorized")).toContain("KINESCOPE_API_TOKEN");
    expect(kinescopeErrorText(403, "")).toContain("нет прав");
    expect(kinescopeErrorText(422, "x")).toBe("Kinescope отклонил запрос (422) (x)");
  });

  test("владелец — из списка комнат", () => {
    const id = "0e2b9b5a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    expect(ownerFromRooms({ data: [{ owner_id: null }, { owner_id: id }] })).toBe(id);
    expect(ownerFromRooms({ data: [] })).toBeNull();
    expect(ownerFromRooms(null)).toBeNull();
  });
});

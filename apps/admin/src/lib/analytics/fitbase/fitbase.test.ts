import { describe, expect, test } from "bun:test";

import {
  fbAttendanceRules,
  fbAttendanceStateLabel,
  fbAttendanceWindow,
  fbCanonicalCity,
  fbCheckpointRow,
  fbClassifiedProduct,
  fbConnectionInput,
  fbCreatedAt,
  fbDomain,
  fbMoneyCents,
  fbPhone,
  fbRevenuePeriod,
  fbScheduleLabel,
  fbShiftMonths,
  fbSuggested,
  fbTrialProduct,
} from "./rules";

// Ожидания — ответы их fitbase_runtime.py / fitbase_trials.py на тех же
// входах (своя транскрипция их функций; данные синтетические).

const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("FitBase: домен и подключение (их domain(), save())", () => {
  test("поддомен из адреса", () => {
    expect(fbDomain("lady-stretch")).toBe("lady-stretch");
    expect(fbDomain(" LADY-jump ")).toBe("lady-jump");
    expect(fbDomain("https://studio.fitbase.io/")).toBe("studio");
    expect(fbDomain("studio.fitbase.tech")).toBe("studio");
    expect(fbDomain("a.fitbase.team")).toBe("a");
  });
  test("их ошибки", () => {
    const path = "Укажите поддомен FitBase без пути и параметров.";
    const bad = "Нужен поддомен клуба FitBase, например lady-stretch.";
    expect(err(() => fbDomain("http://studio.fitbase.io"))).toBe(path);
    expect(err(() => fbDomain("https://studio.fitbase.io:443"))).toBe(path);
    expect(err(() => fbDomain("https://studio.fitbase.io/x"))).toBe(path);
    expect(err(() => fbDomain("https://u@studio.fitbase.io"))).toBe(path);
    expect(err(() => fbDomain("-bad"))).toBe(bad);
    expect(err(() => fbDomain("студия"))).toBe(bad);
  });
  test("поля и ключ", () => {
    const base = {
      id: null,
      name: " Студия ",
      brand: "Lady Stretch",
      city: "Самара",
      domain: "studio",
      partner: "",
      key: " k ",
    };
    expect(fbConnectionInput(base)).toEqual({
      domain: "studio",
      partner: "",
      name: "Студия",
      city: "Самара",
      key: "k",
    });
    expect(err(() => fbConnectionInput({ ...base, key: "" }))).toBe("Введите API-ключ.");
    expect(fbConnectionInput({ ...base, id: 3, key: "" }).key).toBe("");
    expect(err(() => fbConnectionInput({ ...base, city: " " }))).toBe(
      "Заполните студию, направление и город.",
    );
    expect(err(() => fbConnectionInput({ ...base, brand: "Другое" }))).toBe(
      "Заполните студию, направление и город.",
    );
    expect(err(() => fbConnectionInput({ ...base, key: "a\nb" }))).toBe("Некорректный API-ключ.");
  });
  test("их canonical_city: Казань Lady Jump", () => {
    expect(fbCanonicalCity("Lady Jump", "Казань Вишневского")).toBe("Казань · Вишневского");
    expect(fbCanonicalCity("Lady Stretch", "Казань")).toBe("Казань");
  });
});

describe("FitBase: суммы, даты, телефоны (их money_cents, lead_created_at, phone)", () => {
  test("money_cents: Decimal × 100, ROUND_HALF_UP", () => {
    expect(fbMoneyCents(1500.5)).toBe(150050);
    expect(fbMoneyCents("1 500,50")).toBe(150050);
    expect(fbMoneyCents("2.675")).toBe(268);
    expect(fbMoneyCents("-0.005")).toBe(-1);
    expect(fbMoneyCents("1e3")).toBe(100000);
    expect(fbMoneyCents("1_000")).toBe(100000);
    expect(fbMoneyCents("999999999.995")).toBe(100000000000);
    expect(err(() => fbMoneyCents(null))).toBe(
      "FitBase не передал сумму абонемента. Предыдущая выгрузка сохранена.",
    );
    for (const v of ["abc", "", "NaN", "Infinity", "1000000000.01"]) {
      expect(err(() => fbMoneyCents(v))).toBe(
        "Не удалось прочитать сумму абонемента FitBase. Предыдущая выгрузка сохранена.",
      );
    }
  });
  test("дата создания лида — по Москве, их форматы и ошибка", () => {
    expect(fbCreatedAt({ id: 1, created_at: "2024-02-29T00:00:00" })).toBe(1709154000);
    expect(fbCreatedAt({ id: 1, created_at: "01.10.2026" })).toBe(1790802000);
    expect(fbCreatedAt({ id: 1, created_at: "1700000000" })).toBe(1700000000);
    expect(fbCreatedAt({ id: 1, created_at: "2026-10-01T12:30:00+05:00" })).toBe(1790839800);
    expect(
      fbCreatedAt({ id: 1, created_at: "  ", analytics: { created_at_date: "01.10.2026 12:30" } }),
    ).toBe(1790847000);
    expect(err(() => fbCreatedAt({ id: 912, created_at: true }))).toBe(
      "Не удалось прочитать дату создания лида FitBase #912 (формат bool). Предыдущие данные сохранены.",
    );
    expect(err(() => fbCreatedAt({ id: 406 }))).toBe(
      "Не удалось прочитать дату создания лида FitBase #406 (формат NoneType). Предыдущие данные сохранены.",
    );
  });
  test("телефон", () => {
    expect(fbPhone({ phone: "89001234567" })).toBe("79001234567");
    expect(fbPhone({ phone: "+7 (900) 123-45-67" })).toBe("79001234567");
    expect(fbPhone({ phone: "9001234567" })).toBe("79001234567");
    expect(fbPhone({ phone: 79001234567 })).toBe("79001234567");
    expect(fbPhone({ phone: "123" })).toBe("");
    expect(fbPhone({ phone: null })).toBe("");
  });
});

describe("FitBase: пробные и сокращение строк (их trial_product, product, checkpoint_row)", () => {
  test("пробное по названию абонемента", () => {
    expect(fbTrialProduct({ contract_name: "Пробное занятие" })).toEqual(["Пробное занятие", 1]);
    expect(
      fbTrialProduct({ ticket: { contract_item: { id: 6, name: "Пробное занятие" } } }),
    ).toEqual(["Пробное занятие", 1]);
    expect(fbTrialProduct({ ticket: { contract_item: { id: 8, name: " " } }, id: 66 })).toEqual([
      "",
      -1,
    ]);
    expect(
      fbTrialProduct(
        {
          id: 950,
          contract: {
            contract_name: "пробн",
            ticket: { contract_item: { id: 9, name: "ПРОБНАЯ тренировка" } },
          },
          client_contract: { contract_name: "пробныйX" },
        },
        true,
      ),
    ).toEqual(["пробн / ПРОБНАЯ тренировка", 1]);
  });
  test("услуга и абонемент записи", () => {
    expect(
      fbClassifiedProduct({
        id: 636,
        contract: { contract_name: "", ticket: null },
        client_service: {
          id: 40,
          client_id: 64,
          service: { id: 6, available_service: { id: 3, name: "Пробное_1" } },
        },
      }),
    ).toEqual(["Пробное_1", 0]);
    expect(
      fbClassifiedProduct({
        id: 523,
        contract: { contract_name: "ПРОБНАЯ тренировка", id: 10 },
        client_service: {
          id: 44,
          client_id: 57,
          service: { id: 4, available_service: { id: 4, name: "Пробный" } },
        },
      }),
    ).toEqual(["Пробный / ПРОБНАЯ тренировка", 1]);
    expect(
      fbClassifiedProduct({
        id: 883,
        contract: { contract_name: "Разовое", ticket: { contract_item: { id: 4, name: null } } },
        client_service: {
          id: 49,
          client_id: 56,
          service: { id: 7, available_service: { id: 5, name: "Разовое", is_trial: true } },
        },
      }),
    ).toEqual(["Разовое", 1]);
  });
  test("строка лида — только их поля", () => {
    expect(
      fbCheckpointRow("lead", {
        client_id: 65,
        created_at: "2026-13-01",
        deleted_at: 0,
        price: 100,
        status: 3,
        updated_at: 5,
        extra: "drop",
        event: { id: 4, name: "n", registrations_count: { visited: 1 }, x: 1 },
      }),
    ).toEqual({
      client_id: 65,
      created_at: "2026-13-01",
      updated_at: 5,
      deleted_at: 0,
      event: { id: 4, registrations_count: { visited: 1 } },
    });
  });
});

describe("FitBase: правила и подписи", () => {
  test("исход этапа по названию (их suggested)", () => {
    expect(fbSuggested("Записались на пробное")).toBe("booked");
    expect(fbSuggested(" ОПЛАТИЛИ ")).toBe("paid");
    expect(fbSuggested("Новая сделка")).toBe("new");
    expect(fbSuggested("Что-то")).toBe("working");
  });
  test("коды записей: их значения + сохранённые, неизвестное значение не берётся", () => {
    const rules = fbAttendanceRules({ "7": "visited", X9: "", "3": "nonsense" });
    expect(rules["7"]).toBe("visited");
    expect(rules["3"]).toBe("visited");
    expect(rules["0"]).toBe("registered");
    expect("X9" in rules).toBe(false);
  });
  test("прежний текст расхождения счётчиков", () => {
    expect(
      fbAttendanceStateLabel(
        "Занятия загружены · Расхождение счётчиков у 3 занятий; полнота записей подтверждена API.",
      ),
    ).toBe(
      "Занятия загружены · Сверка всей загруженной истории: у 3 занятий сводные счётчики FitBase отличаются. Полный список записей проверен по API; это не число пропущенных занятий.",
    );
  });
  test("периоды занятий и выручки", () => {
    expect(fbShiftMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(fbAttendanceWindow("2026-03-01", "2026-03-31")).toEqual({
      start: "2026-03-01",
      end: "2026-03-31",
      pmStart: "2026-02-01",
      pmEnd: "2026-02-28",
      pyStart: "2025-03-01",
      pyEnd: "2025-03-31",
    });
    expect(fbAttendanceWindow("2025-01-01", "2026-01-01").end).toBe("2026-01-01");
    expect(err(() => fbAttendanceWindow("2025-01-01", "2026-01-02"))).toBe(
      "Выберите период не больше 366 дней.",
    );
    const p = fbRevenuePeriod(0, "2026-10-30");
    expect(p.first).toBe("2026-10-01");
    expect(p.cutoff).toBe("2026-10-29");
    expect(p.elapsed).toBe(29);
    expect(p.history[0]).toBe("2026-09-01");
    expect(p.fromDate).toBe("2026-04-01");
    expect(fbRevenuePeriod(0, "2026-11-01").elapsed).toBe(0);
  });
  test("ночная загрузка в 01:00 МСК", () => {
    const c = { club_id: "100", busy: false };
    const nightly = { last_run_day: "", error: "" };
    // 2026-10-30 00:30 МСК — ещё не время; 20:43 МСК — сегодня не запускалась.
    expect(fbScheduleLabel(c, nightly, 1793309400)).toBe(
      "Следующая загрузка: 30.10.2026 01:00 МСК · ежедневно",
    );
    expect(fbScheduleLabel(c, nightly, 1793382180)).toBe(
      "Ночная загрузка ожидается в течение минуты · ежедневно в 01:00 МСК",
    );
    expect(fbScheduleLabel(c, { last_run_day: "2026-10-30", error: "" }, 1793382180)).toBe(
      "Следующая загрузка: 31.10.2026 01:00 МСК · ежедневно",
    );
    expect(fbScheduleLabel({ club_id: "", busy: false }, nightly, 1793382180)).toBe(
      "Выберите клуб в настройках",
    );
  });
});

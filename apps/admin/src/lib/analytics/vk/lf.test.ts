import { describe, expect, test } from "bun:test";

import {
  LF_HEADERS,
  lfAnswerText,
  lfDateFields,
  lfDisplayTime,
  lfEpoch,
  lfFolderId,
  lfJson,
  lfLeadsPath,
  lfProfileUrl,
  lfRow,
  lfSheetTitle,
  lfStatDate,
  pyStr,
} from "./lf";

describe("VK Ads: лид-формы — правила их lead_forms_collector.py", () => {
  test("время заявки: секунды, миллисекунды, цифры строкой, ISO (без зоны — UTC)", () => {
    expect(lfEpoch(1759660245)).toBe(1759660245);
    expect(lfEpoch(1759660245123)).toBe(1759660245);
    expect(lfEpoch("1759660245")).toBe(1759660245);
    expect(lfEpoch(12.9)).toBe(12);
    expect(lfEpoch(true)).toBe(1);
    expect(lfEpoch("2026-10-05 12:30:45")).toBe(1791203445);
    expect(lfEpoch("2026-10-05T12:30:45+03:00")).toBe(1791192645);
    expect(lfEpoch("2026-10-05T12:30:45.5Z")).toBe(1791203445);
    expect(lfEpoch("2026-10-05")).toBe(1791158400);
    expect([lfEpoch(""), lfEpoch(null), lfEpoch("вчера"), lfEpoch("2026-02-30")]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  test("показ времени и день заявки — по Москве", () => {
    expect(lfDisplayTime(1759660245)).toBe("05.10.2025 13:30:45 +0300");
    expect(lfDisplayTime("нет даты")).toBe("нет даты");
    expect(lfDisplayTime("")).toBe("");
    expect(lfStatDate(1759697999)).toBe("2025-10-05");
    expect(lfStatDate(1759698000)).toBe("2025-10-06");
    expect(lfStatDate(null)).toBeNull();
  });

  test("ответы анкеты: «Вопрос: ответы» построчно, пустые пропускаются", () => {
    expect(
      lfAnswerText({
        answers: [
          { question_text: "Цель", answer_options: [{ text: "Растяжка" }, { value: "Похудение" }] },
          { label: " Возраст ", answer: "30" },
          { title: "Пусто", answers: [] },
          { value: 5 },
          "мусор",
          { title: "Без ответа", answer_options: [{ id: 1 }, null, ""] },
        ],
      }),
    ).toBe("Цель: Растяжка, Похудение\nВозраст: 30\nВопрос: 5");
    expect(lfAnswerText({ answers: "нет" })).toBe("");
    expect(lfProfileUrl({ contact_info: { social_media_profile: " https://vk.com/id1 " } })).toBe(
      "https://vk.com/id1",
    );
    expect(lfProfileUrl({ contact_info: null })).toBe("");
  });

  test("строка таблицы A–W: str() Python (None — «None»), JSON заявки, ссылка на профиль", () => {
    const lead = {
      id: 77,
      form_id: 5,
      created_at: 1759660245,
      status: "new",
      impression_id: null,
      contact_info: {
        first_name: "Анна",
        last_name: null,
        phone: "+7 900",
        social_media_profile: "",
      },
      answers: [{ question_text: "Цель", answer: "Растяжка" }],
    };
    const row = lfRow(
      {
        vk_lead_id: "77",
        vk_account_id: "7000001",
        ad_plan_id: "10",
        ad_group_id: "None",
        banner_id: "",
        vk_form_id: "5",
        form_name: null,
        account_name: "Кабинет",
        city: "Абакан",
        partner_name: "",
        created_at_vk: "1759660245",
        received_at: 1759660300,
      },
      lead,
    );
    expect(row).toHaveLength(LF_HEADERS.length);
    expect(row).toEqual([
      "77",
      "7000001",
      "10",
      "None",
      "",
      "5",
      "",
      "Кабинет",
      "Абакан",
      "",
      "Анна",
      "None",
      "+7 900",
      "",
      "Цель: Растяжка",
      "05.10.2025 13:30:45 +0300",
      "05.10.2025 13:31:40 +0300",
      "new",
      "None",
      "",
      "",
      JSON.stringify(lead),
      "",
    ]);
    expect([pyStr(1.5), pyStr(true), pyStr(undefined), lfJson(""), lfJson(null)]).toEqual([
      "1.5",
      "True",
      "",
      "",
      "",
    ]);
  });

  test("запрос заявок, название таблицы, папка Drive, поля дат", () => {
    expect(lfLeadsPath("12", 100, 200)).toBe(
      "/api/v1/lead_ads/leads.json?lead_form_id=12&limit=100&offset=200",
    );
    expect(lfSheetTitle("", "Каб")).toBe("Без города — Каб — ЛФ VK Ads");
    expect(lfFolderId("https://drive.google.com/drive/folders/1AbC_d-9/")).toBe("1AbC_d-9");
    expect(lfFolderId(" https://drive.google.com/drive/folders/1AbC?usp=sharing ")).toBe("1AbC");
    for (const bad of [
      "http://drive.google.com/drive/folders/1",
      "https://docs.google.com/drive/folders/1",
      "https://drive.google.com/drive/folders/a.b",
      "папка",
    ]) {
      expect(() => lfFolderId(bad)).toThrow("Укажите корректную ссылку на папку Google Drive.");
    }
    expect(
      lfDateFields({ id: 1, created_at: 1, consent_timestamp: 2, Updated_Time: 3, phone: 4 }),
    ).toEqual(["created_at", "consent_timestamp", "Updated_Time"]);
  });
});

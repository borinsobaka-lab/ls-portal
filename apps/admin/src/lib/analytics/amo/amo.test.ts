import { describe, expect, test } from "bun:test";

import {
  AMO_START,
  amoConnectionCheck,
  amoCustomValue,
  amoFlag,
  amoLeadRow,
  amoLeadsPath,
  amoMetadata,
  amoNormalizeBaseUrl,
  amoPipelineKey,
  amoSyncDetails,
  amoUtmFieldIds,
  pyInt,
  type AmoSyncContext,
} from "./rules";

const cf = (field_id: number, value: unknown, enum_id?: number) => ({
  field_id,
  values: [{ value, ...(enum_id ? { enum_id } : {}) }],
});

const CTX: AmoSyncContext = {
  settings: {
    new_lead_pipeline_id: "111",
    auto_source_field_id: "1",
    manual_source_field_id: "2",
    booked_field_id: "3",
    attended_field_id: "4",
    paid_field_id: "5",
    close_basis_field_id: "6",
  },
  utm: { utm_source: "10", utm_campaign: "11" },
  responsibles: new Map([
    ["900", { amo_user_name: "Анна", brand: "Lady Jump", city: "Тула", partner_name: "ИП" }],
  ]),
  pipelineBrands: new Map([["111", "Lady Stretch"]]),
  unqualified: new Set(["501"]),
};

describe("amoCRM — правила их amocrm.py", () => {
  test("адрес подключения: https, домен amoCRM / Kommo, без пути", () => {
    expect(amoNormalizeBaseUrl(" https://Lady.AmoCRM.ru/ ")).toBe("https://lady.amocrm.ru");
    expect(amoNormalizeBaseUrl("https://x.kommo.com:8443")).toBe("https://x.kommo.com:8443");
    expect(amoNormalizeBaseUrl("https://x.amocrm.ru/?a=1")).toBe("https://x.amocrm.ru");
    for (const bad of [
      "http://x.amocrm.ru",
      "https://x.amocrm.ru/leads",
      "x.amocrm.ru",
      "https://",
    ]) {
      expect(() => amoNormalizeBaseUrl(bad)).toThrow("Укажите адрес AmoCRM");
    }
    expect(() => amoNormalizeBaseUrl("https://amocrm.ru.evil.com")).toThrow("*.amocrm.ru");
    expect(() => amoConnectionCheck({ name: " ", baseUrl: "плохо", token: "короткий" })).toThrow(
      "Укажите понятное название подключения.",
    );
    expect(() => amoConnectionCheck({ name: "Есть", baseUrl: "плохо", token: "короткий" })).toThrow(
      "Токен AmoCRM выглядит неполным.",
    );
    expect(
      amoConnectionCheck({
        name: " CRM ",
        baseUrl: "https://a.amocrm.ru",
        token: " " + "t".repeat(20),
      }),
    ).toEqual({ name: "CRM", token: "t".repeat(20), baseUrl: "https://a.amocrm.ru" });
  });

  test("поля сделки: первое значение, этапы, UTM по коду или названию", () => {
    const lead = {
      custom_fields_values: [
        cf(1, "  ВК  "),
        cf(6, "Мужчина", 501),
        { field_id: 7, values: [] },
        "мусор",
      ],
    };
    expect(amoCustomValue(lead, "1")).toEqual(["", "ВК"]);
    expect(amoCustomValue(lead, "6")).toEqual(["501", "Мужчина"]);
    expect(amoCustomValue(lead, "7")).toEqual(["", ""]);
    expect(amoCustomValue({ custom_fields_values: null }, "1")).toEqual(["", ""]);
    const flag = (v: unknown) => amoFlag({ custom_fields_values: [cf(3, v)] }, "3");
    expect([flag("да"), flag(true), flag(1), flag("Оплачено")]).toEqual([1, 1, 1, 1]);
    expect([
      flag("Нет"),
      flag("0"),
      flag(false),
      flag(0),
      flag("NONE"),
      flag(null),
      flag(""),
    ]).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(
      amoUtmFieldIds([
        { id: "10", code: "UTM_SOURCE", name: "Источник" },
        { id: "11", code: "", name: "UTM Campaign" },
        { id: "12", code: "", name: "utm term" },
        { id: "13", code: "", name: "Другое" },
      ]),
    ).toEqual({ utm_source: "10", utm_campaign: "11", utm_term: "12" });
  });

  test("сделка: отсев, бренд воронки, город ответственного, источник, этапы, квалификация", () => {
    expect(amoLeadRow({ id: null, created_at: AMO_START }, CTX)).toEqual({ kind: "invalid" });
    expect(amoLeadRow({ id: 1, created_at: AMO_START - 1 }, CTX)).toEqual({ kind: "before" });
    const out = amoLeadRow(
      {
        id: 77,
        pipeline_id: 111,
        status_id: 143,
        responsible_user_id: 900,
        created_at: AMO_START + 10,
        custom_fields_values: [
          cf(2, "Звонок"),
          cf(5, "да"),
          cf(6, "Мужчина", 501),
          cf(11, "осень"),
        ],
      },
      CTX,
    );
    if (out.kind !== "row") throw new Error(out.kind);
    expect(out.row).toMatchObject({
      amo_lead_id: "77",
      updated_at: AMO_START + 10,
      pipeline_id: "111",
      status_id: "143",
      brand: "Lady Stretch",
      city: "Тула",
      partner_name: "ИП",
      responsible_name: "Анна",
      automatic_source: "",
      responsible_source: "Звонок",
      effective_source: "Звонок",
      utm_campaign: "осень",
      is_paid: 1,
      is_attended: 1,
      is_booked: 1,
      is_closed: 1,
      close_basis_value_id: "501",
      is_qualified: 0,
    });
    const avito = amoLeadRow(
      {
        id: "8",
        pipeline_id: 222,
        responsible_user_id: 900,
        created_at: String(AMO_START),
        updated_at: AMO_START + 5,
        custom_fields_values: [cf(1, "Сайт"), cf(10, "AVITO_ADS"), cf(6, "Мужчина", 501)],
      },
      CTX,
    );
    if (avito.kind !== "row") throw new Error(avito.kind);
    expect(avito.row).toMatchObject({
      brand: "Lady Jump",
      effective_source: "Авито Реклама",
      utm_source: "AVITO_ADS",
      is_closed: 0,
      is_qualified: 1,
      is_booked: 0,
      updated_at: AMO_START + 5,
    });
    const none = amoLeadRow({ id: 9, created_at: AMO_START, responsible_user_id: 1 }, CTX);
    if (none.kind !== "row") throw new Error(none.kind);
    expect(none.row).toMatchObject({
      brand: "",
      city: "",
      effective_source: "Не присвоен источник",
    });
  });

  test("int() Python, справочники без лишнего, итог сверки, путь сделок", () => {
    expect([pyInt(null), pyInt("12"), pyInt(12.9), pyInt(true), pyInt("")]).toEqual([
      0, 12, 12, 1, 0,
    ]);
    expect(() => pyInt("abc")).toThrow("invalid literal for int()");
    expect(
      amoMetadata(
        { _embedded: { pipelines: [{ id: 1, name: "П", is_archive: true, _embedded: {} }] } },
        {
          _embedded: {
            custom_fields: [
              { id: 2, name: "Ф", code: null, enums: [{ id: 3, value: "З", sort: 1 }] },
            ],
          },
        },
        { _embedded: { users: [{ id: 4, name: "Ю", email: "secret@example.com", rights: {} }] } },
      ),
    ).toEqual({
      pipelines: [{ id: "1", name: "П", is_archive: true }],
      fields: [{ id: "2", name: "Ф", code: "", enums: [{ id: "3", value: "З" }] }],
      users: [{ id: "4", name: "Ю" }],
    });
    expect(() => amoMetadata({ _embedded: { pipelines: {} } }, {}, {})).toThrow(
      "AmoCRM вернула неожиданный формат справочников.",
    );
    expect(amoPipelineKey({})).toBe("без ID");
    expect(
      amoSyncDetails({
        kind: "incremental",
        expected: "111",
        pipelines: new Map([
          ["без ID", 1],
          ["222", 3],
          ["111", 5],
        ]),
        other: 3,
        before: 0,
        invalid: 1,
      }),
    ).toBe(
      "Обновление изменённых сделок. Ожидаемая воронка ID 111; AmoCRM вернула по воронкам: 111: 5, 222: 3, без ID: 1. Отсеяно: другая воронка — 3, до 01.09.2026 — 0, без ID — 1.",
    );
    expect(amoLeadsPath("updated", 100, 2)).toBe(
      "/api/v4/leads?filter%5Bupdated_at%5D%5Bfrom%5D=100&page=2&limit=250",
    );
  });
});

import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AdminAccess } from "@/lib/admin-access";

import { canUseTool, filterTools, TOOL_SECTIONS } from "./access";
import { createAssistantTools } from "./tools.server";

const access = (
  over: Partial<AdminAccess> & { sections?: AdminAccess["studios"][string]["sections"] },
) => ({
  rights: [],
  kbAdmin: false,
  manageAll: false,
  manageStudioIds: [],
  rail: over.rail ?? null,
  studios: { s1: { owner: false, sections: over.sections ?? null } },
});

const NETWORK = { rights: [], kbAdmin: false, manageAll: false, manageStudioIds: [] };

describe("права Kate по разделам «Доступов»", () => {
  test("у каждого инструмента названы разделы", () => {
    const tools = createAssistantTools({} as SupabaseClient, "s1");
    expect(Object.keys(tools).sort()).toEqual(Object.keys(TOOL_SECTIONS).sort());
  });

  test("без настроенных прав — всё открыто", () => {
    const a = access({});
    for (const name of Object.keys(TOOL_SECTIONS)) expect(canUseTool(a, "s1", name)).toBe(true);
  });

  test("закрытая касса — нет инструмента кассы, клиенты есть", () => {
    const a = access({ sections: ["clients", "schedule"] });
    expect(canUseTool(a, "s1", "list_cash_operations")).toBe(false);
    expect(canUseTool(a, "s1", "list_sales")).toBe(false);
    expect(canUseTool(a, "s1", "list_clients")).toBe(true);
    expect(canUseTool(a, "s1", "counts_overview")).toBe(true);
  });

  test("без раздела «Клуб» в рейке — разделов клуба нет, «Мобильное приложение» — по рейке", () => {
    const a = access({ rail: ["app"] });
    expect(canUseTool(a, "s1", "list_clients")).toBe(false);
    expect(canUseTool(a, "s1", "list_news")).toBe(true);
    expect(canUseTool(a, "s1", "list_trainers")).toBe(true);
  });

  test("чужой клуб и неизвестный инструмент закрыты", () => {
    expect(canUseTool(access({}), "other", "list_clients")).toBe(false);
    expect(canUseTool(access({}), "s1", "drop_everything")).toBe(false);
  });

  test("владелец клуба видит всё в своём клубе", () => {
    const a: AdminAccess = {
      ...NETWORK,
      rail: ["club"],
      studios: { s1: { owner: true, sections: ["clients"] } },
    };
    expect(canUseTool(a, "s1", "list_cash_operations")).toBe(true);
  });

  test("filterTools оставляет только открытые", () => {
    const tools = { list_cash_operations: 1, list_clients: 2 };
    expect(Object.keys(filterTools(tools, access({ sections: ["clients"] }), "s1"))).toEqual([
      "list_clients",
    ]);
  });
});

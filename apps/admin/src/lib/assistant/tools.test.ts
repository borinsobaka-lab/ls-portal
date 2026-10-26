import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays, studioDayStart, studioToday } from "./dates";
import { createAssistantTools } from "./tools.server";

type FakeResult = { data: unknown; error: { message: string } | null };

/**
 * Поддельный клиент: записывает цепочку вызовов и отвечает заданным
 * результатом (или своим для каждой таблицы).
 */
function fakeSupabase(result: FakeResult | ((table: string) => FakeResult)) {
  const calls: string[] = [];
  const builder = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") {
            const r = typeof result === "function" ? result(table) : result;
            return (resolve: (v: unknown) => void) => resolve({ ...r, count: 0 });
          }
          return (...args: unknown[]) => {
            calls.push(`${table}.${prop}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
            return builder(table);
          };
        },
      },
    );
  const client = {
    from: (table: string) => builder(table),
    rpc: (fn: string, args: unknown) => {
      calls.push(`rpc.${fn}(${JSON.stringify(args)})`);
      return builder(`rpc:${fn}`);
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const run = async (
  tools: ReturnType<typeof createAssistantTools>,
  name: keyof ReturnType<typeof createAssistantTools>,
  input: unknown,
) => {
  const t = tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  return t.execute(input, { toolCallId: "t1", messages: [] });
};

describe("даты студии", () => {
  test("сегодня — по Тбилиси, а не по UTC", () => {
    // 22:30 UTC 9 октября = 02:30 10 октября в Тбилиси.
    expect(studioToday(new Date("2026-10-09T22:30:00Z"))).toBe("2026-10-10");
  });
  test("addDays переходит через месяц", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  test("начало суток с поясом студии", () => {
    expect(studioDayStart("2026-10-09")).toBe("2026-10-09T00:00:00+04:00");
  });
});

describe("инструменты Kate", () => {
  test("история записей фильтрует по starts_at, «по» включительно", async () => {
    const { client, calls } = fakeSupabase({ data: [], error: null });
    await run(createAssistantTools(client, "s1"), "list_bookings_log", {
      from: "2026-10-01",
      to: "2026-10-09",
      limit: 10,
    });
    expect(calls).toContain('bookings_log.gte("starts_at", "2026-10-01T00:00:00+04:00")');
    expect(calls).toContain('bookings_log.lt("starts_at", "2026-10-10T00:00:00+04:00")');
    expect(calls.some((c) => c.includes("created_at"))).toBe(false);
  });

  test("отзывы — только своей студии или без студии", async () => {
    const { client, calls } = fakeSupabase({ data: [], error: null });
    await run(createAssistantTools(client, "s1"), "list_feedback", { limit: 10 });
    expect(calls).toContain('feedback.or("studio_id.eq.s1,studio_id.is.null")');
  });

  test("ошибка базы возвращается как error, а не как пустой список", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "boom" } });
    const res = await run(createAssistantTools(client, "s1"), "list_sales", { limit: 10 });
    expect(res).toEqual({ error: "boom" });
  });

  test("сумма продаж считается по строкам", async () => {
    const { client } = fakeSupabase({
      data: [{ total_amount: 100 }, { total_amount: "50.5" }, { total_amount: null }],
      error: null,
    });
    const res = (await run(createAssistantTools(client, "s1"), "list_sales", {
      limit: 10,
    })) as { count: number; total_amount: number };
    expect(res.count).toBe(3);
    expect(res.total_amount).toBe(150.5);
  });

  test("клиенты пакетного клуба — общей базы всех пакетных клубов, подписочного — только его", async () => {
    const studios = [
      { id: "p1", format: "packages" },
      { id: "s1", format: "subscription" },
      { id: "p2", format: "packages" },
    ];
    const answer = (table: string) => ({ data: table === "studios" ? studios : [], error: null });
    const pack = fakeSupabase(answer);
    await run(createAssistantTools(pack.client, "p2"), "list_clients", { limit: 10 });
    expect(pack.calls).toContain('clients_with_status.in("studio_id", ["p1","p2"])');
    const sub = fakeSupabase(answer);
    await run(createAssistantTools(sub.client, "s1"), "list_clients", { limit: 10 });
    expect(sub.calls).toContain('clients_with_status.in("studio_id", ["s1"])');
  });

  test("сводка не выдаёт ошибку запроса за ноль", async () => {
    const { client } = fakeSupabase({ data: null, error: { message: "denied" } });
    const res = (await run(createAssistantTools(client, "s1"), "counts_overview", {})) as Record<
      string,
      unknown
    >;
    expect(res.clients).toBeNull();
    expect(res.errors).toBeDefined();
  });

  test("клиенты: id учётной записи не уходит модели — только факт входа и имя", async () => {
    const { client } = fakeSupabase({
      data: [{ id: "c1", user_id: "u1", last_name: "Иванова", first_name: "Анна", full_name: "x" }],
      error: null,
    });
    const res = (await run(createAssistantTools(client, "s1"), "list_clients", {
      limit: 10,
      order_by: "added_desc",
    })) as { rows: Record<string, unknown>[] };
    expect(res.rows[0].user_id).toBeUndefined();
    expect(res.rows[0]).toMatchObject({ has_app: true, client_name: "Иванова Анна" });
  });

  test("сводки приложения, «давно не был» и дни рождения — RPC текущего клуба", async () => {
    const { client, calls } = fakeSupabase({ data: [{ client_id: "c1" }], error: null });
    const tools = createAssistantTools(client, "s1");
    const res = (await run(tools, "list_app_clients", { order: "registered", limit: 5 })) as {
      count: number;
    };
    expect(res.count).toBe(1);
    await run(tools, "list_inactive_members", { days: 21, limit: 10 });
    await run(tools, "list_birthdays", { days: 3 });
    expect(calls).toContain(
      'rpc.assistant_app_clients({"p_studio_id":"s1","p_order":"registered","p_since":null,"p_limit":5})',
    );
    expect(calls).toContain(
      'rpc.assistant_inactive_members({"p_studio_id":"s1","p_days":21,"p_limit":10})',
    );
    expect(calls).toContain('rpc.assistant_birthdays({"p_studio_id":"s1","p_days":3})');
  });

  test("заканчивающиеся: в пакетном клубе — и по остатку; купившие продление и пробные исключены", async () => {
    const today = studioToday();
    const soon = addDays(today, 3);
    const studios = [{ id: "p1", format: "packages" }];
    let cmCall = 0;
    const answer = (table: string) => {
      if (table === "studios") return { data: studios, error: null };
      cmCall += 1;
      if (cmCall === 1) {
        return {
          data: [
            {
              id: "m1",
              client_id: "c1",
              balance_kind: "group",
              ends_at: soon,
              visits_left: 4,
              created_at: "2026-09-01",
              clients: { id: "c1", last_name: "Петрова", first_name: "Ольга" },
              memberships: { name: "Пакет 8", kind: "package" },
            },
            {
              id: "m2",
              client_id: "c2",
              balance_kind: "group",
              ends_at: addDays(today, 40),
              visits_left: 1,
              created_at: "2026-09-01",
              clients: { id: "c2", last_name: "Сидорова", first_name: "Мария" },
              memberships: { name: "Пакет 8", kind: "package" },
            },
            {
              id: "m3",
              client_id: "c3",
              balance_kind: "group",
              ends_at: soon,
              visits_left: 2,
              created_at: "2026-09-01",
              clients: { id: "c3", last_name: "Купила", first_name: "Уже" },
              memberships: { name: "Пакет 8", kind: "package" },
            },
            {
              id: "m4",
              client_id: "c4",
              balance_kind: "group",
              ends_at: addDays(today, -1),
              visits_left: 0,
              created_at: "2026-09-01",
              clients: { id: "c4", last_name: "Прошёл", first_name: "Срок" },
              memberships: { name: "Пакет 8", kind: "package" },
            },
            {
              id: "m5",
              client_id: "c5",
              balance_kind: "group",
              ends_at: null,
              visits_left: 1,
              created_at: "2026-09-01",
              clients: { id: "c5", last_name: "Пробник", first_name: "Новый" },
              memberships: { name: "Пробное", kind: "trial" },
            },
          ],
          error: null,
        };
      }
      // Продления: у c3 ждёт следующий абонемент.
      return {
        data: [{ id: "m9", client_id: "c3", status: "pending", balance_kind: "group" }],
        error: null,
      };
    };
    const { client, calls } = fakeSupabase(answer);
    const res = (await run(createAssistantTools(client, "p1"), "list_expiring_client_memberships", {
      within_days: 14,
      low_balance: 2,
      include_renewed: false,
      limit: 50,
    })) as { rows: Record<string, unknown>[]; renewed_excluded: number };
    expect(res.rows.map((r) => [r.client_name, r.reason])).toEqual([
      ["Петрова Ольга", "ends_soon"],
      ["Сидорова Мария", "low_balance"],
    ]);
    expect(res.renewed_excluded).toBe(1);
    expect(res.rows[0].days_left).toBe(3);
    expect(calls.some((c) => c.includes("balance_kind.eq.personal,personal_left.lte.2"))).toBe(
      true,
    );
  });

  test("заканчивающиеся в подписочном клубе — без условия по остатку", async () => {
    const studios = [{ id: "s1", format: "subscription" }];
    const { client, calls } = fakeSupabase((t) => ({
      data: t === "studios" ? studios : [],
      error: null,
    }));
    await run(createAssistantTools(client, "s1"), "list_expiring_client_memberships", {
      within_days: 7,
      low_balance: 2,
      include_renewed: false,
      limit: 50,
    });
    const or = calls.find((c) => c.startsWith("client_memberships.or("));
    expect(or).toBeDefined();
    expect(or).not.toContain("visits_left");
  });

  test("пробные без покупки: купившие после пробного не попадают, отменённая покупка — не покупка", async () => {
    const studios = [{ id: "p1", format: "packages" }];
    let salesCall = 0;
    const answer = (table: string) => {
      if (table === "studios") return { data: studios, error: null };
      salesCall += 1;
      if (salesCall === 1) {
        return {
          data: [
            {
              id: "t1",
              client_id: "c1",
              sold_at: "2026-10-01",
              clients: { last_name: "Купила" },
              memberships: { name: "Пробное", kind: "trial" },
            },
            {
              id: "t2",
              client_id: "c2",
              sold_at: "2026-10-02",
              clients: { last_name: "Думает" },
              memberships: { name: "Пробное", kind: "trial" },
            },
            {
              id: "t3",
              client_id: "c3",
              sold_at: "2026-10-03",
              clients: { last_name: "Вернула" },
              memberships: { name: "Разовое", kind: "single" },
            },
          ],
          error: null,
        };
      }
      return {
        data: [
          {
            client_id: "c1",
            sold_at: "2026-10-05",
            memberships: { kind: "package" },
            client_memberships: { status: "active" },
          },
          {
            client_id: "c2",
            sold_at: "2026-10-02",
            memberships: { kind: "trial" },
            client_memberships: { status: "expired" },
          },
          {
            client_id: "c3",
            sold_at: "2026-10-04",
            memberships: { kind: "package" },
            client_memberships: { status: "refunded" },
          },
        ],
        error: null,
      };
    };
    const { client } = fakeSupabase(answer);
    const res = (await run(createAssistantTools(client, "p1"), "list_trials_without_purchase", {
      from: "2026-10-01",
      to: "2026-10-31",
      include_bought: false,
      limit: 100,
    })) as { rows: Record<string, unknown>[]; trials_total: number; conversion_percent: number };
    expect(res.rows.map((r) => r.client_name)).toEqual(["Думает", "Вернула"]);
    expect(res.trials_total).toBe(3);
    expect(res.conversion_percent).toBe(33);
  });

  test("«Абонементы» пакетного клуба в подписочном — понятная ошибка, без запроса", async () => {
    const { client, calls } = fakeSupabase((t) => ({
      data: t === "studios" ? [{ id: "s1", format: "subscription" }] : [],
      error: null,
    }));
    const res = (await run(createAssistantTools(client, "s1"), "list_package_sales", {
      limit: 10,
    })) as { error?: string };
    expect(res.error).toContain("только у клубов с пакетами");
    expect(calls.some((c) => c.startsWith("client_packages_list"))).toBe(false);
  });

  test("платежи: просроченные отдельно, сумма просрочки", async () => {
    const today = studioToday();
    const { client } = fakeSupabase({
      data: [
        {
          id: "i1",
          amount: 100,
          due_date: addDays(today, -3),
          sales: {
            id: "s",
            client_id: "c1",
            clients: { last_name: "Должник" },
            memberships: { name: "Пакет" },
          },
        },
        {
          id: "i2",
          amount: 50,
          due_date: addDays(today, 1),
          sales: { id: "s2", client_id: "c2", clients: { last_name: "Скоро" }, memberships: null },
        },
      ],
      error: null,
    });
    const res = (await run(createAssistantTools(client, "s1"), "list_installments_due", {
      within_days: 3,
      limit: 100,
    })) as Record<string, unknown> & { rows: Record<string, unknown>[] };
    expect(res).toMatchObject({ overdue_count: 1, overdue_amount: 100, upcoming_amount: 50 });
    expect(res.rows[0]).toMatchObject({
      client_name: "Должник",
      overdue: true,
      membership_name: "Пакет",
    });
  });

  test("карточка клиента: закрытые разделы не запрашиваются", async () => {
    const { client, calls } = fakeSupabase((t) => ({
      data:
        t === "clients_with_status"
          ? { id: "c1", user_id: null, last_name: "Иванова", first_name: "Анна" }
          : [],
      error: null,
    }));
    const tools = createAssistantTools(client, "s1", { canSee: (k) => k === "clients" });
    const res = (await run(tools, "get_client_details", {
      client_id: "00000000-0000-4000-8000-000000000001",
    })) as Record<string, unknown>;
    expect(res.client).toMatchObject({ client_name: "Иванова Анна", has_app: false });
    expect(res.sales).toBeUndefined();
    expect(res.nps).toBeUndefined();
    expect(calls.some((c) => c.startsWith("sales."))).toBe(false);
    expect(calls.some((c) => c.startsWith("rpc.client_app_overview"))).toBe(false);
  });
});

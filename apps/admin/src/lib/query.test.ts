import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";

import { resetQueriesForUser } from "./query";

/** Запрос, который ещё грузится, когда приходит сессия (обновление страницы). */
function slowObserver(client: QueryClient) {
  let calls = 0;
  const observer = new QueryObserver(client, {
    queryKey: ["kb_nodes", "base"],
    queryFn: () =>
      new Promise<string>((resolve) => {
        calls += 1;
        const n = calls;
        setTimeout(() => resolve(`ответ ${n}`), 20);
      }),
    retry: false,
  });
  const states: string[] = [];
  const unsubscribe = observer.subscribe((r) => states.push(`${r.status}/${r.fetchStatus}`));
  return { observer, unsubscribe, calls: () => calls, states };
}

describe("смена вошедшего — кэш запросов", () => {
  test("clear() оставлял экран в вечной загрузке (так было)", async () => {
    const client = new QueryClient();
    const { observer, unsubscribe } = slowObserver(client);
    await Bun.sleep(1);
    client.clear();
    await Bun.sleep(60);
    const r = observer.getCurrentResult();
    expect(r.status).toBe("pending");
    expect(r.fetchStatus).toBe("fetching");
    unsubscribe();
  });

  test("resetQueriesForUser — экран получает ответ нового запроса", async () => {
    const client = new QueryClient();
    const { observer, unsubscribe, calls } = slowObserver(client);
    await Bun.sleep(1);
    await resetQueriesForUser(client);
    await Bun.sleep(60);
    const r = observer.getCurrentResult();
    expect(r.status).toBe("success");
    expect(r.data).toBe("ответ 2");
    expect(calls()).toBe(2);
    unsubscribe();
  });

  test("неактивные запросы со старыми данными удаляются", async () => {
    const client = new QueryClient();
    client.setQueryData(["studios"], ["клуб без сессии"]);
    await resetQueriesForUser(client);
    expect(client.getQueryData(["studios"])).toBeUndefined();
  });
});

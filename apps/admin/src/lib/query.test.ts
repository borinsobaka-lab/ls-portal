import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/query-core";

import { resetQueriesForUser } from "./query";

/** Запрос, который ещё грузится, когда приходит сессия (обновление страницы). */
function slowObserver(client: QueryClient, key = "kb_nodes") {
  let calls = 0;
  const observer = new QueryObserver(client, {
    queryKey: [key],
    queryFn: () =>
      new Promise<string>((resolve) => {
        calls += 1;
        const n = calls;
        setTimeout(() => resolve(`ответ ${n}`), 20);
      }),
    retry: false,
  });
  const datas: (string | undefined)[] = [];
  const unsubscribe = observer.subscribe((r) => datas.push(r.data));
  return { observer, unsubscribe, calls: () => calls, datas };
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

  test("запрос в полёте доходит до ответа", async () => {
    const client = new QueryClient();
    const { observer, unsubscribe } = slowObserver(client);
    await Bun.sleep(1);
    await resetQueriesForUser(client);
    await Bun.sleep(60);
    const r = observer.getCurrentResult();
    expect(r.status).toBe("success");
    expect(r.data).toBeDefined();
    unsubscribe();
  });

  test("загруженные данные на экране не обнуляются, а перезапрашиваются", async () => {
    const client = new QueryClient();
    const { observer, unsubscribe, calls, datas } = slowObserver(client, "access");
    await Bun.sleep(60);
    expect(observer.getCurrentResult().data).toBe("ответ 1");
    const before = datas.length;
    await resetQueriesForUser(client);
    expect(calls()).toBe(2);
    expect(observer.getCurrentResult().data).toBe("ответ 2");
    expect(datas.slice(before)).not.toContain(undefined);
    unsubscribe();
  });

  test("неактивные запросы со старыми данными удаляются", async () => {
    const client = new QueryClient();
    client.setQueryData(["studios"], ["клуб без сессии"]);
    await resetQueriesForUser(client);
    expect(client.getQueryData(["studios"])).toBeUndefined();
  });
});

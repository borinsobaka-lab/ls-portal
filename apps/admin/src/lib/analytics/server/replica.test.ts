import { describe, expect, test } from "bun:test";

import { agentLogRow, chunkRows, replicaSignature, verifyReplicaRequest } from "./replica.server";

describe("приём синхронизации со старого портала", () => {
  const secret = "s".repeat(40);
  const body = new TextEncoder().encode('{"batch":"1","items":[]}');

  test("подпись агента принимается, чужая и устаревшая — нет", () => {
    const now = 1_790_000_000_000;
    const time = String(now / 1000);
    const sig = replicaSignature(secret, time, body);
    expect(verifyReplicaRequest(secret, time, sig, body, now)).toBeNull();
    expect(verifyReplicaRequest("x".repeat(40), time, sig, body, now)).toBe("Неверная подпись");
    expect(verifyReplicaRequest(secret, time, sig, body, now + 3_600_000)).toBe("Подпись устарела");
    expect(verifyReplicaRequest(secret, null, sig, body, now)).toBe("Нет подписи");
    const other = new TextEncoder().encode('{"batch":"2","items":[]}');
    expect(verifyReplicaRequest(secret, time, sig, other, now)).toBe("Неверная подпись");
  });

  test("подпись совпадает с агентом (deploy/analytics-replica/agent.py, sign)", () => {
    expect(replicaSignature(secret, "1790000000", body)).toBe(
      "c8769ba0efed58c6ff4f7107f10b58467e6679304fdb0fd0f61f6f13ac9c0c8e",
    );
  });

  test("отметка агента: первая ошибка по таблицам — в журнал", () => {
    const ok = agentLogRow("b1", { version: "1.0", sources: [{ target: "an_legacy_users" }] });
    expect(ok.target).toBe("agent");
    expect(ok.error).toBeNull();
    const bad = agentLogRow("b2", {
      version: "1.0",
      sources: [
        { target: "an_legacy_users", error: null },
        { target: "an_legacy_audit", error: "Нет таблицы audit_log" },
      ],
    });
    expect(bad.error).toBe("1 табл. с ошибкой: an_legacy_audit — Нет таблицы audit_log");
    const huge = agentLogRow(null, {
      version: "1.0",
      host: "h",
      sources: [],
      blob: "x".repeat(60_000),
    });
    expect(huge.details).toEqual({ version: "1.0", host: "h" });
  });

  test("строки режутся на пачки по числу и объёму", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, text: "x".repeat(100) }));
    expect(chunkRows(rows, 4).map((c) => c.length)).toEqual([4, 4, 2]);
    expect(chunkRows(rows, 100, 250).map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
    expect(chunkRows([])).toEqual([]);
  });
});

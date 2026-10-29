import { describe, expect, test } from "bun:test";

import { chunkRows, replicaSignature, verifyReplicaRequest } from "./replica.server";

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

  test("строки режутся на пачки по числу и объёму", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i, text: "x".repeat(100) }));
    expect(chunkRows(rows, 4).map((c) => c.length)).toEqual([4, 4, 2]);
    expect(chunkRows(rows, 100, 250).map((c) => c.length)).toEqual([2, 2, 2, 2, 2]);
    expect(chunkRows([])).toEqual([]);
  });
});

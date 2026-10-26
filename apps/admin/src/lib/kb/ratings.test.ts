import { describe, expect, test } from "bun:test";

import { countScores, kbScore, ratingIndex } from "./ratings";

describe("оценки статей", () => {
  test("счётчики и средняя", () => {
    const c = countScores([3, 3, 2, 1]);
    expect(c).toEqual({ count: 4, bad: 1, ok: 1, good: 2 });
    expect(ratingIndex(c)).toBe(63);
    expect(ratingIndex(countScores([]))).toBeNull();
  });
  test("подпись по оценке", () => {
    expect(kbScore(1).key).toBe("bad");
    expect(kbScore(3).key).toBe("good");
  });
});

/**
 * «Что изменилось» между версиями статьи: построчное сравнение (наибольшая
 * общая подпоследовательность). Строки — documentLines (lib/kb/document.ts).
 */
import type { KbDocLine } from "./document";

export type KbDiffOp = "same" | "add" | "del";
export type KbDiffLine = KbDocLine & { op: KbDiffOp };

/** Выше — сравнение по таблице слишком дорогое: показываем «было / стало». */
const MAX_CELLS = 4_000_000;

const key = (l: KbDocLine) => `${l.kind}\u0000${l.depth}\u0000${l.text}`;

export function diffLines(before: KbDocLine[], after: KbDocLine[]): KbDiffLine[] {
  const a = before.map(key);
  const b = after.map(key);
  // Общие начало и конец — без таблицы.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = after.slice(0, start).map((l) => ({ ...l, op: "same" as const }));
  const tail = after.slice(endB).map((l) => ({ ...l, op: "same" as const }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  const middle: KbDiffLine[] = [];
  if (n * m > MAX_CELLS) {
    for (const l of before.slice(start, endA)) middle.push({ ...l, op: "del" });
    for (const l of after.slice(start, endB)) middle.push({ ...l, op: "add" });
    return [...head, ...middle, ...tail];
  }
  // lcs[i][j] — длина общей подпоследовательности хвостов midA[i:], midB[j:].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      middle.push({ ...after[start + j], op: "same" });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // При равенстве — сначала убранное: читается «было → стало».
      middle.push({ ...before[start + i], op: "del" });
      i++;
    } else {
      middle.push({ ...after[start + j], op: "add" });
      j++;
    }
  }
  return [...head, ...middle, ...tail];
}

/** Сколько строк добавлено и убрано. */
export function diffStats(lines: KbDiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "del") removed++;
  }
  return { added, removed };
}

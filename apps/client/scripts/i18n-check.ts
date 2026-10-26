/**
 * Проверка переводов клиентского приложения (bun run i18n:check):
 *
 * 1. каждый ключ из кода — t("…"), msg("…"), t.plural(n, "…") — есть в
 *    словарях en и ka (src/i18n/dictionaries/); нет — ошибка, выход 1;
 * 2. подстановки {name} в переводе те же, что в ключе;
 * 3. --unused: ключи словарей, которых больше нет в коде;
 * 4. --leftovers [путь…]: строки с кириллицей вне t()/msg() и комментариев —
 *    кандидаты на забытый перевод (не ошибка: бывают и нужные).
 *
 * Ключ, собранный в рантайме (t(variable)), проверить нельзя — подписи в
 * константах помечать msg("…").
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SRC = path.join(ROOT, "src");
const SKIP = [
  path.join(SRC, "i18n", "dictionaries"),
  path.join(SRC, "integrations"),
  path.join(SRC, "routeTree.gen.ts"),
];

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (SKIP.some((s) => full === s || full.startsWith(s + path.sep))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const LITERAL = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`(?:[^\`\\$]|\\.|\$(?!\{))*\`)`;
const CALL_RE = new RegExp(String.raw`(?<![\w.])(?:t|msg)\(\s*` + LITERAL, "g");
const PLURAL_RE = new RegExp(String.raw`\.plural\(\s*[^"'\`;]*?,\s*` + LITERAL, "g");

function decode(literal: string): string {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  if (quote === '"') return JSON.parse(literal.replace(/\\'/g, "'"));
  if (quote === "'") return JSON.parse('"' + body.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
  // шаблон без подстановок
  return body
    .replace(/\\`/g, "`")
    .replace(/\\\$/g, "$")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

type Found = { key: string; file: string; line: number };

/**
 * Комментарии — пробелами (позиции и номера строк сохраняются). Строки и
 * шаблоны пропускаются целиком: "image/*" или "https://…" — не комментарий.
 */
function stripComments(text: string) {
  const out = text.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      // до закрывающей кавычки (в шаблоне ${…} не разбираем — ключи без подстановок)
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") i++;
        else if (c !== "`" && text[i] === "\n") break;
        i++;
      }
      i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      const to = close < 0 ? text.length : close + 2;
      blank(i, to);
      i = to;
    } else if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      const to = nl < 0 ? text.length : nl;
      blank(i, to);
      i = to;
    } else {
      i++;
    }
  }
  return out.join("");
}

function lineOf(text: string, index: number) {
  return text.slice(0, index).split("\n").length;
}

const files = walk(SRC);
const found: Found[] = [];
const sources = new Map<string, string>();
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  sources.set(file, raw);
  const text = stripComments(raw);
  for (const re of [CALL_RE, PLURAL_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      try {
        found.push({ key: decode(m[1]), file, line: lineOf(text, m.index) });
      } catch {
        console.warn(
          `! не разобрать строку: ${path.relative(ROOT, file)}:${lineOf(text, m.index)}`,
        );
      }
    }
  }
}

const keys = new Map<string, Found>();
for (const f of found) if (!keys.has(f.key)) keys.set(f.key, f);

const dictionaries: Record<string, Record<string, string>> = {
  en: (await import(path.join(SRC, "i18n/dictionaries/en/index.ts"))).default,
  ka: (await import(path.join(SRC, "i18n/dictionaries/ka/index.ts"))).default,
};

const vars = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)]
    .map((m) => m[1])
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort()
    .join(",");

let errors = 0;
for (const [lang, dict] of Object.entries(dictionaries)) {
  const missing = [...keys.values()].filter((f) => !(f.key in dict));
  if (missing.length) {
    errors += missing.length;
    console.log(`\n✗ ${lang}: нет перевода — ${missing.length}`);
    for (const f of missing)
      console.log(`  ${path.relative(ROOT, f.file)}:${f.line}  ${JSON.stringify(f.key)}`);
  }
  for (const [key, value] of Object.entries(dict)) {
    if (!keys.has(key)) continue;
    const keyVars = vars(key);
    // У плюралов в каждой форме свои подстановки — сверяем объединение.
    if (vars(value) !== keyVars && !key.includes("|")) {
      console.log(
        `! ${lang}: подстановки не совпадают: ${JSON.stringify(key)} → ${JSON.stringify(value)}`,
      );
    }
    if (!value.trim()) console.log(`! ${lang}: пустой перевод: ${JSON.stringify(key)}`);
  }
}

const args = process.argv.slice(2);
if (args.includes("--unused")) {
  for (const [lang, dict] of Object.entries(dictionaries)) {
    const unused = Object.keys(dict).filter((k) => !keys.has(k));
    if (unused.length) {
      console.log(`\n· ${lang}: нет в коде — ${unused.length}`);
      for (const k of unused) console.log(`  ${JSON.stringify(k)}`);
    }
  }
}

const leftoversAt = args.indexOf("--leftovers");
if (leftoversAt >= 0) {
  const only = args.slice(leftoversAt + 1).filter((a) => !a.startsWith("--"));
  const targets = only.length
    ? files.filter((f) => only.some((o) => f.startsWith(path.resolve(ROOT, o))))
    : files;
  let count = 0;
  for (const file of targets) {
    const text = sources.get(file)!;
    // Убираем комментарии и переведённые строки, ищем оставшуюся кириллицу.
    const stripped = stripComments(text)
      .replace(CALL_RE, (m) => m.replace(/[^\n]/g, " "))
      .replace(PLURAL_RE, (m) => m.replace(/[^\n]/g, " "));
    stripped.split("\n").forEach((line, i) => {
      if (/[А-Яа-яЁё]/.test(line)) {
        count++;
        console.log(`  ${path.relative(ROOT, file)}:${i + 1}  ${text.split("\n")[i].trim()}`);
      }
    });
  }
  console.log(`\n· кириллица вне t()/msg(): ${count} строк`);
}

console.log(
  `\n${keys.size} ключей в коде; en — ${Object.keys(dictionaries.en).length}, ka — ${Object.keys(dictionaries.ka).length} в словарях.`,
);
if (errors) {
  console.log(`✗ без перевода: ${errors}`);
  process.exit(1);
}
console.log("✓ все ключи переведены");

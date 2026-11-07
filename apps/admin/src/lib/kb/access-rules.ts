/**
 * «Кто видит» раздел, папку или статью базы знаний — как в Platrum
 * (db/migrations/2026-11-07_kb_section_access.sql). Без своего списка узел
 * видят как раздел выше, а без него — все, кому открыта база. Модуль без
 * React: список, подписи, сравнение.
 */

export const KB_ACCESS_SUBJECTS = ["user", "position", "unit", "role"] as const;
export type KbAccessSubject = (typeof KB_ACCESS_SUBJECTS)[number];

export type KbAccessRule = {
  subject_type: KbAccessSubject;
  subject_id: string;
  /** Подразделение: все сотрудники или руководители и заместители. */
  unit_members: "all" | "heads";
  /** Подразделение: и подразделения ниже по дереву. */
  with_subunits: boolean;
};

/** Ответ kb_node_access_get. */
export type KbNodeAccess = {
  custom: boolean;
  /** Чей список действует (свой узел или раздел выше); null — доступ к базе. */
  source_id: string | null;
  source_title: string | null;
  /** Сколько человек видят сейчас — без редакторов базы и администраторов. */
  viewers: number;
  /** Список, который действует (свой или раздела выше). */
  rules: KbAccessRule[];
};

export const KB_ACCESS_SUBJECT_LABEL: Record<KbAccessSubject, string> = {
  user: "Сотрудник",
  position: "Должность",
  unit: "Подразделение",
  role: "Роль",
};

export function ruleKey(rule: Pick<KbAccessRule, "subject_type" | "subject_id">): string {
  return `${rule.subject_type}:${rule.subject_id}`;
}

/** Добавить в список; тот же субъект — заменить (настройки подразделения). */
export function addRule(rules: KbAccessRule[], rule: KbAccessRule): KbAccessRule[] {
  const key = ruleKey(rule);
  const normalized: KbAccessRule =
    rule.subject_type === "unit" ? rule : { ...rule, unit_members: "all", with_subunits: true };
  return rules.some((r) => ruleKey(r) === key)
    ? rules.map((r) => (ruleKey(r) === key ? normalized : r))
    : [...rules, normalized];
}

export function removeRule(rules: KbAccessRule[], key: string): KbAccessRule[] {
  return rules.filter((r) => ruleKey(r) !== key);
}

/** Пояснение к строке подразделения; у остальных — нет. */
export function ruleHint(rule: KbAccessRule): string | null {
  if (rule.subject_type !== "unit") return null;
  const who = rule.unit_members === "heads" ? "руководители и заместители" : "все сотрудники";
  return rule.with_subunits ? `${who}, и подразделения ниже` : who;
}

/** Совпадают ли списки (порядок не важен) — есть ли что сохранять. */
export function rulesEqual(a: KbAccessRule[], b: KbAccessRule[]): boolean {
  if (a.length !== b.length) return false;
  const sig = (r: KbAccessRule) =>
    `${ruleKey(r)}:${r.subject_type === "unit" ? `${r.unit_members}:${r.with_subunits}` : ""}`;
  const set = new Set(a.map(sig));
  return b.every((r) => set.has(sig(r)));
}

/** «Видят …» — кто видит узел без своего списка. */
export function inheritedText(access: Pick<KbNodeAccess, "source_id" | "source_title">): string {
  return access.source_id
    ? `Как у «${access.source_title || "раздел выше"}» — действует его список.`
    : "Как в базе — видят все, кому открыта база.";
}

/** «N человек» по-русски. */
export function peopleCount(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 === 1 && mod100 !== 11
      ? "человек"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "человека"
        : "человек";
  return `${n} ${word}`;
}

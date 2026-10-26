/**
 * Права в базах знаний (db/migrations/2026-10-24_knowledge_base.sql).
 *
 * Владелец (owner хоть в одной студии) — «manage» во всех базах: создаёт базы,
 * правит всё, раздаёт доступы. Остальным сотрудникам владелец выдаёт доступ в
 * «Доступах»: по каждой базе «просмотр» или «правка»; нет строки — базы не
 * видно. Граница — RLS, здесь — только что показать в интерфейсе. Модуль без
 * React: его читает и сервер «Доступов».
 */

export const KB_GRANT_LEVELS = ["view", "edit"] as const;
export type KbGrantLevel = (typeof KB_GRANT_LEVELS)[number];
export type KbLevel = KbGrantLevel | "manage";

export type KbGrant = { base_id: string; level: KbGrantLevel };

export const KB_LEVEL_LABEL: Record<KbGrantLevel, string> = {
  view: "Просмотр",
  edit: "Правка",
};

/** Уровень в базе: владельцу — manage, иначе из выданного; null — закрыта. */
export function kbLevelOf(kbAdmin: boolean, grants: KbGrant[], baseId: string): KbLevel | null {
  if (kbAdmin) return "manage";
  return grants.find((g) => g.base_id === baseId)?.level ?? null;
}

export function canEditKb(level: KbLevel | null | undefined): boolean {
  return level === "edit" || level === "manage";
}

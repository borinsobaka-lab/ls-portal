/**
 * «Компания» — справочник людей портала и оргструктура для просмотра
 * (TASKS_CHATS_PLAN.md, веха 1; RPC company_people / company_structure —
 * db/migrations/2026-11-07_zz_portal_notifications.sql). Всем людям портала:
 * партнёры видят друг друга (решение владельца 2026-11-07).
 */
import { queryOptions } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { MemberRole, UserType } from "@/lib/access/types";
import { unwrap } from "@/lib/query";

export type CompanyPerson = {
  user_id: string;
  full_name: string;
  avatar_url: string | null;
  email: string | null;
  phone: string | null;
  user_type: UserType | null;
  position_id: string | null;
  position_name: string | null;
  units: { id: string; name: string; role: MemberRole }[];
  clubs: { id: string; name: string; role: "owner" | "admin" | "trainer"; city: string | null }[];
  cities: string[];
  last_seen_at: string | null;
};

export type CompanyUnit = {
  id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  sort_order: number;
  members: { user_id: string; role: MemberRole }[];
};

export const companyPeopleQuery = queryOptions({
  queryKey: ["company_people"],
  queryFn: async () => (await unwrap<CompanyPerson[] | null>(supabase.rpc("company_people"))) ?? [],
  // «В сети» меняется — раз в минуту, пока страница открыта.
  refetchInterval: 60_000,
  meta: { errorMessage: "Не удалось загрузить сотрудников" },
});

export const companyStructureQuery = queryOptions({
  queryKey: ["company_structure"],
  queryFn: async () =>
    (await unwrap<CompanyUnit[] | null>(supabase.rpc("company_structure"))) ?? [],
  staleTime: 5 * 60_000,
  meta: { errorMessage: "Не удалось загрузить структуру" },
});

/** В сети — пульс вкладки портала за последние 2 минуты (раз в минуту). */
export const ONLINE_MS = 2 * 60_000;

export function isOnline(lastSeen: string | null, now = Date.now()): boolean {
  return !!lastSeen && now - new Date(lastSeen).getTime() < ONLINE_MS;
}

/** «в сети», «был 5 мин назад», «был вчера в 18:40», «был 3 марта». */
export function lastSeenLabel(lastSeen: string | null, now = new Date()): string {
  if (!lastSeen) return "не заходил";
  const d = new Date(lastSeen);
  const diff = now.getTime() - d.getTime();
  if (diff < ONLINE_MS) return "в сети";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `был ${min} мин назад`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(d, now)) return `был сегодня в ${hh}:${mm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `был вчера в ${hh}:${mm}`;
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ];
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `был ${d.getDate()} ${months[d.getMonth()]}${year}`;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/** Поиск по словам: каждое слово — в имени, почте, телефоне, должности, подразделении, клубе или городе. */
export function matchPerson(p: CompanyPerson, query: string): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const digits = (p.phone ?? "").replace(/\D/g, "");
  const hay = norm(
    [
      p.full_name,
      p.email,
      p.phone,
      p.position_name,
      ...p.units.map((u) => u.name),
      ...p.clubs.map((c) => c.name),
      ...p.cities,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return words.every((w) => {
    if (/^\+?\d[\d\s()-]*$/.test(w)) {
      const wd = w.replace(/\D/g, "");
      return wd.length > 0 && digits.includes(wd);
    }
    return hay.includes(w);
  });
}

/** Подразделения деревом: дети по порядку; id подразделения и всех ниже. */
export function unitChildren(units: CompanyUnit[]): Map<string | null, CompanyUnit[]> {
  const ids = new Set(units.map((u) => u.id));
  const map = new Map<string | null, CompanyUnit[]>();
  for (const u of units) {
    const parent = u.parent_id && ids.has(u.parent_id) ? u.parent_id : null;
    const list = map.get(parent) ?? [];
    list.push(u);
    map.set(parent, list);
  }
  for (const list of map.values())
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ru"));
  return map;
}

export function unitWithDescendants(
  children: Map<string | null, CompanyUnit[]>,
  id: string,
): Set<string> {
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of children.get(cur) ?? []) {
      if (!out.has(c.id)) {
        out.add(c.id);
        stack.push(c.id);
      }
    }
  }
  return out;
}

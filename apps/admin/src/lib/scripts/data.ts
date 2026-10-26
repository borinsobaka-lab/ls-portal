/**
 * «Скрипты LS» — загрузка и запись (React Query + Supabase).
 *
 * Дерево (разделы и скрипты) грузится целиком: скриптов десятки, а не
 * тысячи, и поиск мгновенный, только когда тексты уже в браузере. Его читают
 * и боковое меню (список разделов), и страница — один queryKey на обоих.
 * После правки — invalidateScripts(): меню и страница не расходятся.
 */
import { useCallback, useState } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { useAdminAccess } from "@/hooks/use-admin-access";
import { canOpenRail } from "@/lib/admin-access";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { isLang } from "./logic";
import type {
  CallFlow,
  ScriptItem,
  ScriptLang,
  ScriptSection,
  ScriptSettings,
  ScriptStaff,
  ScriptVariable,
} from "./types";

export const SCRIPTS_KEY = "scripts_sections";
export const SETTINGS_KEY = "scripts_settings";
export const UNREAD_KEY = "scripts_unread";

type SectionRow = Omit<ScriptSection, "items">;

async function loadPlaybook(): Promise<ScriptSection[]> {
  const [sections, items] = await Promise.all([
    unwrap<SectionRow[]>(
      supabase
        .from("scripts_sections")
        .select(
          "id, title, icon, position, kind, flow, flow_updated_at, flow_updated_by, flow_change_note",
        )
        .order("position")
        .order("created_at"),
    ),
    unwrap<ScriptItem[]>(
      supabase
        .from("scripts_items")
        .select(
          "id, section_id, title, kind, keywords, note, follow_up, variants, position, updated_at, updated_by, change_note",
        )
        .order("position")
        .order("title"),
    ),
  ]);
  const bySection = new Map<string, ScriptItem[]>();
  for (const item of items) {
    const list = bySection.get(item.section_id) ?? [];
    list.push(item);
    bySection.set(item.section_id, list);
  }
  return sections.map((s) => ({
    ...s,
    flow: s.kind === "call" ? (s.flow as CallFlow) : null,
    items: bySection.get(s.id) ?? [],
  }));
}

/** Разделы со скриптами. enabled=false — не грузить (раздел закрыт). */
export function usePlaybook(enabled = true) {
  return useQuery({
    queryKey: [SCRIPTS_KEY],
    queryFn: loadPlaybook,
    enabled,
    // Скрипты меняются редко: переходы по разделам не перезапрашивают дерево.
    staleTime: 60_000,
    meta: { errorMessage: "Не удалось загрузить скрипты" },
  });
}

export function invalidateScripts(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: [SCRIPTS_KEY] });
}

const EMPTY_LANG = { ru: "", en: "", ka: "" };

/** Настройки из JSONB — к одному виду: старые/импортированные поля могут отсутствовать. */
export function normalizeSettings(
  row: { data: Record<string, unknown>; updated_at: string | null; updated_by: string } | null,
): ScriptSettings {
  const data = (row?.data ?? {}) as Partial<ScriptSettings>;
  const variables = Array.isArray(data.variables) ? data.variables : [];
  return {
    studios: Array.isArray(data.studios)
      ? data.studios.map((s) => ({ ...EMPTY_LANG, ...s, name: s.name ?? s.ru ?? "" }))
      : [],
    admins: data.admins && typeof data.admins === "object" ? data.admins : {},
    variables: variables.map(
      (v): ScriptVariable => ({
        ...EMPTY_LANG,
        ...v,
        key: v.key ?? "",
        type: v.type === "date" ? "date" : "text",
        description: v.description ?? "",
        offset_days: v.offset_days ?? 0,
      }),
    ),
    updated_at: row?.updated_at ?? null,
    updated_by: row?.updated_by ?? "",
  };
}

export function useScriptSettings(enabled = true) {
  return useQuery({
    queryKey: [SETTINGS_KEY],
    queryFn: async () =>
      normalizeSettings(
        await unwrap<{
          data: Record<string, unknown>;
          updated_at: string | null;
          updated_by: string;
        } | null>(
          supabase.from("scripts_settings").select("data, updated_at, updated_by").maybeSingle(),
        ),
      ),
    enabled,
    staleTime: 60_000,
    meta: { errorMessage: "Не удалось загрузить настройки скриптов" },
  });
}

/** Сотрудники с разделом «Скрипты LS» — для имён {админ}. */
export function useScriptStaff(enabled = true) {
  return useQuery({
    queryKey: ["scripts_staff"],
    queryFn: () => unwrap<ScriptStaff[]>(supabase.rpc("scripts_staff")),
    enabled,
    meta: { errorMessage: "Не удалось загрузить сотрудников" },
  });
}

/**
 * Права на раздел: читать (рейка «Скрипты LS») и править («Скрипты LS:
 * правка»). null — права ещё грузятся. Это интерфейс — границу держит RLS.
 */
export function useScriptAccess(): { canRead: boolean; canEdit: boolean } | null {
  const access = useAdminAccess();
  if (!access) return null;
  const canRead = canOpenRail(access, "scripts");
  return {
    canRead,
    canEdit: canRead && (access.rail === null || access.rail.includes("scripts-edit")),
  };
}

/**
 * Новые предложения, которых этот сотрудник ещё не видел (свои не
 * считаются). Проверяется раз в минуту — значок появится, пока сотрудник
 * работает в скриптах.
 */
export function useUnreadSuggestions(enabled: boolean) {
  return useQuery({
    queryKey: [UNREAD_KEY],
    enabled,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      const userId = session.session?.user.id;
      if (!userId) return 0;
      const seen = await unwrap<{ suggestions_seen_at: string } | null>(
        supabase
          .from("scripts_seen")
          .select("suggestions_seen_at")
          .eq("user_id", userId)
          .maybeSingle(),
      );
      let q = supabase
        .from("scripts_suggestions")
        .select("id", { count: "exact", head: true })
        .neq("author_id", userId);
      if (seen) q = q.gt("created_at", seen.suggestions_seen_at);
      const { count, error } = await q;
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  });
}

/** Отметить предложения прочитанными. Возвращает прежнюю отметку (для подсветки новых). */
export async function markSuggestionsSeen(): Promise<string | null> {
  const { data: session } = await supabase.auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) return null;
  const { data: prev } = await supabase
    .from("scripts_seen")
    .select("suggestions_seen_at")
    .eq("user_id", userId)
    .maybeSingle();
  // Одним upsert: две вкладки подряд не спорят за одну строку.
  await supabase
    .from("scripts_seen")
    .upsert({ user_id: userId, suggestions_seen_at: new Date().toISOString() });
  return (prev?.suggestions_seen_at as string | undefined) ?? null;
}

/**
 * Отметка «скопировали текст скрипта». Не ждём и не мешаем копированию:
 * у стойки оно не должно зависеть от статистики.
 */
export function logCopy(itemId: string, lang: ScriptLang, studio: string) {
  void supabase
    .from("scripts_copies")
    .insert({ item_id: itemId, lang, studio: studio.slice(0, 120) })
    .then(() => undefined);
}

/* --- Язык и студия: выбираются один раз и запоминаются ------------------ */

const LANG_KEY = "scripts_lang";
const STUDIO_KEY = "scripts_studio";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // приватный режим — выбор просто не переживёт перезагрузку
  }
}

/**
 * Администратор весь день переписывается на одном-двух языках и сидит на
 * одной студии: переключать их у каждого скрипта заново было бы пыткой.
 * Поэтому выбор общий для всех карточек и переживает перезагрузку.
 */
export function useScriptPrefs() {
  const [lang, setLangState] = useState<ScriptLang>(() => {
    const saved = typeof window === "undefined" ? null : read(LANG_KEY);
    return isLang(saved) ? saved : "ru";
  });
  const [studio, setStudioState] = useState<string>(() =>
    typeof window === "undefined" ? "" : (read(STUDIO_KEY) ?? ""),
  );
  const setLang = useCallback((value: ScriptLang) => {
    setLangState(value);
    write(LANG_KEY, value);
  }, []);
  const setStudio = useCallback((value: string) => {
    setStudioState(value);
    write(STUDIO_KEY, value);
  }, []);
  return { lang, setLang, studio, setStudio };
}

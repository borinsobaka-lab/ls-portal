/**
 * VK Ads: «сообщения сообщества» (СС) — их vk_ads.py
 * (`verify_community_message_source`, `sync_community_message_source`,
 * `sync_all_community_message_sources`): из двух Google-таблиц города
 * (лиды — лист «Сбор лидов», дата в C; заявки — лист «Номера», дата в D)
 * берутся только счётчики строк по дням, исходные таблицы не меняются.
 *
 * Задача «vk_ss» (jobs.server.ts) — раз в час, как их
 * lady-community-messages.timer; «Загрузить данные СС» на странице
 * источников — то же для одного города.
 */
import { getSupabaseAdmin } from "@/integrations/supabase/client.server";
import {
  SS_APPLICATIONS_RANGE,
  SS_LEADS_RANGE,
  ssDays,
  ssSpreadsheetId,
  vkCanonicalCity,
} from "../vk/ss";
import { sheetsClient, type SheetsClient } from "./google-sheets.server";
import type { JobResult } from "./jobs.server";

type Source = {
  brand: string;
  city: string;
  leads_sheet_url: string;
  applications_sheet_url: string;
  is_active: boolean;
};

const db = () => getSupabaseAdmin();

async function source(brand: string, city: string, activeOnly: boolean): Promise<Source | null> {
  let q = db()
    .from("an_vk_ss_sources")
    .select("brand, city, leads_sheet_url, applications_sheet_url, is_active")
    .eq("brand", brand.trim())
    .eq("city", vkCanonicalCity(brand, city));
  if (activeOnly) q = q.eq("is_active", true);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Source | null) ?? null;
}

export type SsVerified = {
  brand: string;
  city: string;
  leadsTitle: string;
  leadsSheets: string[];
  applicationsTitle: string;
  applicationsSheets: string[];
};

/** Их «Проверить доступ»: только метаданные таблиц, без данных людей. */
export async function verifySsSource(brand: string, city: string): Promise<SsVerified> {
  const s = await source(brand, city, false);
  if (!s) throw new Error("Источники для этого города не найдены.");
  const sheets = await sheetsClient();
  const leads = await sheets.metadata(ssSpreadsheetId(s.leads_sheet_url));
  const apps = await sheets.metadata(ssSpreadsheetId(s.applications_sheet_url));
  return {
    brand: s.brand,
    city: s.city,
    leadsTitle: leads.title,
    leadsSheets: leads.sheets,
    applicationsTitle: apps.title,
    applicationsSheets: apps.sheets,
  };
}

export type SsSynced = {
  brand: string;
  city: string;
  days: number;
  leads: number;
  applications: number;
};

async function syncOne(s: Source, sheets: SheetsClient): Promise<SsSynced> {
  const leadsRows = await sheets.values(ssSpreadsheetId(s.leads_sheet_url), SS_LEADS_RANGE);
  const appRows = await sheets.values(
    ssSpreadsheetId(s.applications_sheet_url),
    SS_APPLICATIONS_RANGE,
  );
  const days = ssDays(leadsRows, appRows);
  const { error } = await db().rpc("an_vk_ss_store", {
    p_brand: s.brand,
    p_city: s.city,
    p_days: days,
  });
  if (error) throw new Error(error.message);
  return {
    brand: s.brand,
    city: s.city,
    days: days.length,
    leads: days.reduce((n, d) => n + d.leads, 0),
    applications: days.reduce((n, d) => n + d.applications, 0),
  };
}

/** Их «Загрузить данные СС» — один активный источник. */
export async function syncSsSource(brand: string, city: string): Promise<SsSynced> {
  const s = await source(brand, city, true);
  if (!s) throw new Error("Активные источники СС для города не найдены.");
  return syncOne(s, await sheetsClient());
}

/** Задача «vk_ss»: все активные источники по очереди, ошибка одного — в итоге. */
export async function syncAllSs(): Promise<JobResult> {
  const { data, error } = await db()
    .from("an_vk_ss_sources")
    .select("brand, city, leads_sheet_url, applications_sheet_url, is_active")
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  const sources = ((data ?? []) as Source[]).sort(
    (a, b) => cmp(nocase(a.brand), nocase(b.brand)) || cmp(nocase(a.city), nocase(b.city)),
  );
  if (sources.length === 0) return { status: "success", message: "Источников: 0" };
  const results: Record<string, unknown>[] = [];
  let ok = 0;
  let failed = 0;
  let sheets: SheetsClient | null = null;
  let keyError: string | null = null;
  try {
    sheets = await sheetsClient();
  } catch (e) {
    keyError = (e as Error).message;
  }
  for (const s of sources) {
    try {
      if (!sheets) throw new Error(keyError ?? "Ключ Google Sheets не задан.");
      results.push(await syncOne(s, sheets));
      ok++;
    } catch (e) {
      failed++;
      results.push({
        brand: s.brand,
        city: s.city,
        status: "error",
        error: (e as Error).message.slice(0, 200),
      });
    }
  }
  return {
    status: failed === 0 ? "success" : ok === 0 ? "error" : "partial",
    message: `Источников: ${sources.length} · загружено: ${ok} · ошибок: ${failed}`,
    details: { results },
  };
}

/** COLLATE NOCASE SQLite: без регистра только латиница. */
const nocase = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

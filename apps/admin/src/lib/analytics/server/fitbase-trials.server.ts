/**
 * FitBase — пробные занятия на сервере: каталог услуг филиала (их
 * load_catalog), связи записей с услугами (их ensure_refs) и итоговые типы
 * записей (их overrides: выбранные услуги + основания из веб-интерфейса).
 * У них типы считаются при каждом открытии отчёта; здесь — после событий,
 * которые меняют исходные данные (загрузка студии, выбор услуг, каталог,
 * новые основания), и пишутся в an_fb_trial_overrides. Логика —
 * lib/analytics/fitbase/trials.ts; схема —
 * db/migrations/2026-10-30_zzzzzzzzzzzzzzzz_analytics_fitbase_trials.sql.
 */
import { createHash } from "node:crypto";

import { getSupabaseAdmin } from "@/integrations/supabase/client.server";

import { FbError, type Json } from "../fitbase/rules";
import {
  fbApplyBasis,
  fbBasisClassifier,
  fbCatalogRow,
  fbCollectRefs,
  fbServiceOverrides,
  fbTrialOwner,
  type FbTrialRule,
} from "../fitbase/trials";
import { pyStr } from "../vk/lf";
import { fbRequest } from "./fitbase-api.server";
import { apiKey, getBlob, getConn, selectAll, type FbConn } from "./fitbase.server";

const db = () => getSupabaseAdmin();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** Их LOCK: пересчёт одной студии — по очереди. */
const chains = new Map<number, Promise<unknown>>();
function serial<T>(id: number, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
  chains.set(id, next);
  void next.finally(() => {
    if (chains.get(id) === next) chains.delete(id);
  });
  return next;
}

async function ruleOf(id: number, owner: string): Promise<FbTrialRule | null> {
  const { data, error } = await db()
    .from("an_fb_trial_service_rules")
    .select("owner, mode, selected, revision")
    .eq("connection_id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.owner !== owner) return null;
  return {
    mode: data.mode as FbTrialRule["mode"],
    selected: (data.selected as unknown[]).map(String),
    revision: data.revision as number,
  };
}

/** Их stamp(): владелец, загрузки, проверка пробных и кэш выгрузок студии. */
async function stampOf(c: FbConn, owner: string): Promise<string> {
  const [{ data: conn }, { data: quality }, { data: cache }] = await Promise.all([
    db().from("an_fb_connections").select("sales_synced_at").eq("id", c.id).maybeSingle(),
    db().from("an_fb_trial_quality").select("checked_at").eq("connection_id", c.id).maybeSingle(),
    db()
      .from("an_fb_incremental")
      .select("scope, object_path, cursor_at")
      .eq("connection_id", c.id)
      .order("scope"),
  ]);
  const rows = (cache ?? []) as { scope: string; object_path: string; cursor_at: number }[];
  return JSON.stringify([
    owner,
    c.attendance_synced_at,
    conn?.sales_synced_at ?? null,
    quality?.checked_at ?? null,
    [
      rows.length,
      Math.max(0, ...rows.map((r) => r.cursor_at)),
      sha256(rows.map((r) => `${r.scope}\u0000${r.object_path}`).join("\n")),
      c.checks_path,
    ],
  ]);
}

/**
 * Их ensure_refs: услуги каждой записи из сохранённых выгрузок записей,
 * активаций услуг и адресных сверок занятий; пересчёт — когда меняется метка.
 */
async function ensureRefs(c: FbConn, owner: string): Promise<[string, string[]][]> {
  const stamp = await stampOf(c, owner);
  const { data: index } = await db()
    .from("an_fb_trial_service_index")
    .select("owner, stamp")
    .eq("connection_id", c.id)
    .maybeSingle();
  if (index && index.owner === owner && index.stamp === stamp) {
    const rows = await selectAll<{ registration_id: string; owner: string; service_ids: string[] }>(
      "an_fb_trial_service_refs",
      c.id,
      "registration_id",
    );
    return rows.filter((r) => r.owner === owner).map((r) => [r.registration_id, r.service_ids]);
  }
  const records = await selectAll<{ registration_id: string; client_key: string }>(
    "an_fb_records",
    c.id,
    "registration_id",
  );
  const clients = new Map(records.map((r) => [r.registration_id, r.client_key]));
  const { data: scopes, error } = await db()
    .from("an_fb_incremental")
    .select("endpoint, object_path, cursor_at")
    .eq("connection_id", c.id)
    .in("endpoint", ["schedule-registration", "activated-services"])
    .gt("cursor_at", 0)
    .order("cursor_at");
  if (error) throw new Error(error.message);
  const baseline = new Map<string, Json>();
  const activations: Json[] = [];
  for (const s of scopes ?? []) {
    const rows = await getBlob<Json[]>(s.object_path as string, []);
    if (s.endpoint === "activated-services") activations.push(...rows);
    else for (const row of rows) baseline.set(pyStr(row.id), row);
  }
  const checks = await getBlob<Record<string, { rows?: Json[] }>>(c.checks_path, {});
  for (const proof of Object.values(checks)) {
    for (const row of proof.rows ?? []) {
      if (!baseline.has(pyStr(row.id))) baseline.set(pyStr(row.id), row);
    }
  }
  const refs = [...fbCollectRefs([...baseline.values()], activations, clients, c.club_id)].map(
    ([rid, ids]) => [rid, [...ids].sort()] as [string, string[]],
  );
  const { error: storeError } = await db().rpc("an_fb_trial_refs_store", {
    p_id: c.id,
    p_owner: owner,
    p_stamp: stamp,
    p_refs: refs,
  });
  if (storeError) throw new Error(storeError.message);
  return refs;
}

/**
 * Итоговые типы записей студии (их overrides): в режиме «По выбранным
 * услугам» — по связям с услугами, затем основания из веб-интерфейса.
 */
export function fbTrialRecompute(id: number): Promise<void> {
  return serial(id, async () => {
    const { data: exists } = await db()
      .from("an_fb_connections")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (!exists) return;
    const c = await getConn(id);
    const owner = fbTrialOwner(c);
    const rule = c.club_id ? await ruleOf(id, owner) : null;
    let values = new Map<string, number>();
    if (rule?.mode === "selected") {
      values = fbServiceOverrides(rule, await ensureRefs(c, owner));
      const [basis, records, catalog, products] = await Promise.all([
        selectAll<{ owner: string; registration_id: string; event_id: string; label: string }>(
          "an_fb_trial_basis",
          id,
          "registration_id",
        ),
        selectAll<{ registration_id: string; event_id: string }>(
          "an_fb_records",
          id,
          "registration_id",
        ),
        selectAll<{ owner: string; service_id: string; name: string }>(
          "an_fb_trial_service_catalog",
          id,
          "service_id",
        ),
        selectAll<{ label: string; is_trial: number }>("an_fb_trial_products", id, "item_id", [
          "kind",
          "contract",
        ]),
      ]);
      const events = new Map(records.map((r) => [r.registration_id, r.event_id]));
      values = fbApplyBasis(
        values,
        basis.filter((b) => b.owner === owner && events.get(b.registration_id) === b.event_id),
        fbBasisClassifier(
          rule,
          catalog.filter((k) => k.owner === owner),
          products,
        ),
      );
    }
    const { error } = await db().rpc("an_fb_trial_overrides_store", {
      p_id: id,
      p_owner: owner,
      p_rows: [...values],
    });
    if (error) throw new Error(error.message);
  });
}

/**
 * Их load_catalog: услуги клуба из FitBase (действующие и архивные), до 20
 * страниц по 100, не дольше 2 минут; при ошибке прежний каталог остаётся.
 */
export async function fbTrialLoadCatalog(id: number): Promise<void> {
  const c = await getConn(id);
  const owner = fbTrialOwner(c);
  const session = { domain: c.domain, key: await apiKey(id) };
  const rows = new Map<string, Record<string, unknown>>();
  const deadline = performance.now() + 120_000;
  for (const archived of [0, 1]) {
    const seen = new Set<string>();
    let exhausted = false;
    for (let page = 1; page <= 20; page++) {
      if (performance.now() > deadline)
        throw new FbError(
          "FitBase слишком долго отвечает. Прежний каталог сохранён; повторите позже.",
        );
      const data = await fbRequest(session, "available-services", page, {
        "club_ids[]": c.club_id,
        archive: archived,
        page_size: 100,
      });
      const items = (data.items ?? []) as unknown[];
      if (!items.length) {
        exhausted = true;
        break;
      }
      let added = 0;
      for (const item of items) {
        let row: ReturnType<typeof fbCatalogRow>;
        try {
          row = fbCatalogRow(item, c.club_id, archived);
        } catch (e) {
          throw new FbError((e as Error).message);
        }
        if (!row) continue;
        if (!seen.has(row.service_id)) added += 1;
        seen.add(row.service_id);
        rows.set(row.service_id, row);
      }
      const total = data.total_count;
      if (typeof total === "number" && Number.isInteger(total) && seen.size >= total) {
        exhausted = true;
        break;
      }
      if (!added)
        throw new FbError("FitBase повторил страницу каталога. Прежний каталог сохранён.");
      await sleep(200);
    }
    if (!exhausted)
      throw new FbError("Каталог слишком большой для одного запроса. Прежний каталог сохранён.");
  }
  const { error } = await db().rpc("an_fb_trial_catalog_store", {
    p_id: id,
    p_owner: owner,
    p_rows: [...rows.values()],
  });
  if (error) throw new FbError(error.message);
  await fbTrialRecompute(id);
}

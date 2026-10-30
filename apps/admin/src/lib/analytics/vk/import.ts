/**
 * VK Ads: импорт кабинетов из Excel (их VK Ads Panel —
 * export_vk_ads_accounts.py): разбор файла в браузере, без запросов.
 */
import { iterRows, openXlsx, pyStrip, type Cell, type Inflate } from "../onec/xlsx-read";
import { pyFloatStr } from "../reviews/parse";

export type VkImportRecord = {
  name: string;
  vk_account_id: string;
  token: string;
  city: string;
  partner_name: string;
  brand: string;
};

/** str(value) Python для значения ячейки openpyxl (data_only). */
function cellText(v: Cell): string {
  if (v === null) return "None";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatStr(v);
  if (typeof v === "boolean") return v ? "True" : "False";
  return String(v);
}

/** Истинность значения ячейки в Python: пусто, 0 и False — ложь. */
const truthy = (v: Cell | undefined) =>
  v !== null && v !== undefined && v !== "" && v !== 0 && v !== false;

/**
 * Их export_vk_ads_accounts.py: активный лист, со второй строки; A —
 * название, B — ID VK Ads, E — API-ключ; строки без любого из них
 * пропускаются; город и партнёр — пустые (в портале их не стирают).
 */
export async function vkAccountsFromXlsx(
  bytes: Uint8Array,
  inflate: Inflate,
): Promise<VkImportRecord[]> {
  const book = await openXlsx(bytes, inflate);
  const out: VkImportRecord[] = [];
  for await (const row of iterRows(book, { minRow: 2 })) {
    if (!truthy(row[0]) || !truthy(row[1]) || !truthy(row[4])) continue;
    out.push({
      name: pyStrip(cellText(row[0])),
      vk_account_id: pyStrip(cellText(row[1])),
      token: pyStrip(cellText(row[4])),
      city: "",
      partner_name: "",
      brand: "",
    });
  }
  return out;
}

export const browserInflate: Inflate = async function* (data) {
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"))
    .getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
};

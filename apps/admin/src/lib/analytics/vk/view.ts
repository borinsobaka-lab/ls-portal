/**
 * VK Ads — подписи и форматы их страниц «Рекламные кабинеты» и «Расходы по
 * кабинетам» (их app.py: `vk_ads_page`, `vk_ads_spend_page`): суммы с НДС
 * ×1,22, f"{x:,.2f}" с пробелом между тысячами, статус ключа, поиск и
 * фильтры списка кабинетов.
 */
import { pyRound } from "../onec-reports/payload";

/** Их VAT_MULTIPLIER: расходы VK Ads — без НДС, на страницах — с ним. */
export const VK_VAT = 1.22;

/** f"{x:,.<digits>f}".replace(",", " ") Python. */
export function vkNumber(x: number, digits: number): string {
  const fixed = pyRound(x, digits).toFixed(digits);
  const [int, frac] = fixed.split(".");
  const sign = int.startsWith("-") ? "-" : "";
  const digitsOnly = sign ? int.slice(1) : int;
  const grouped = digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return sign + grouped + (frac !== undefined ? `.${frac}` : "");
}

/** Их подпись ключа кабинета по последней проверке сбором. */
export function vkVerification(status: number | null): string {
  if (status === 200) return "ключ проверен";
  if (status) return `ошибка HTTP ${status}`;
  return "не проверен";
}

export type VkAccountRow = {
  id: number;
  name: string;
  vk_account_id: string;
  city: string;
  brand: string;
  partner_name: string;
  is_active: boolean;
  last_verified_at: string | null;
  last_verification_status: number | null;
  last_balance_at: string | null;
  last_balance: string | null;
};

/** Их data-search строки: название, ID, бренд, город, партнёр (без регистра). */
export function vkAccountSearchText(a: VkAccountRow): string {
  return [a.name, a.vk_account_id, a.brand, a.city, a.partner_name]
    .join(" ")
    .toLocaleLowerCase("ru");
}

/**
 * Их фильтр списка: поиск — подстрока; город и партнёр — тоже подстрока
 * той же строки (как у них: data-search.includes(значение фильтра)).
 */
export function vkAccountMatches(
  a: VkAccountRow,
  f: { query: string; city: string; partner: string },
): boolean {
  const text = vkAccountSearchText(a);
  const q = f.query.trim().toLocaleLowerCase("ru");
  return (
    (!q || text.includes(q)) &&
    (!f.city || text.includes(f.city.toLocaleLowerCase("ru"))) &&
    (!f.partner || text.includes(f.partner.toLocaleLowerCase("ru")))
  );
}

/** Их сортировка по остатку: без остатка — как −1. */
export const vkBalanceSort = (a: VkAccountRow) =>
  a.last_balance === null ? -1 : Number(a.last_balance);

export type VkSpendRow = {
  account_id: number;
  name: string;
  vk_account_id: string;
  city: string;
  partner_name: string;
  is_active: boolean;
  platform_spent: number;
  lead_form_spent: number;
  updated_at: string | null;
  campaign_rows: number;
};

export type VkSpendTotals = {
  total: number;
  leadForms: number;
  messages: number;
  withData: number;
  accounts: number;
};

/** Их итоги «Расходов по кабинетам»: всего, ЛФ, СС — остаток после ЛФ (с НДС). */
export function vkSpendTotals(rows: VkSpendRow[]): VkSpendTotals {
  const total = rows.reduce((s, r) => s + (r.platform_spent || 0), 0) * VK_VAT;
  const leadForms = rows.reduce((s, r) => s + (r.lead_form_spent || 0), 0) * VK_VAT;
  return {
    total,
    leadForms,
    messages: total - leadForms,
    withData: rows.filter((r) => r.campaign_rows).length,
    accounts: rows.length,
  };
}

/** Строка таблицы расходов: с данными — суммы с НДС, СС не меньше нуля. */
export function vkSpendCells(r: VkSpendRow) {
  const has = !!r.campaign_rows;
  return {
    has,
    total: has ? vkNumber((r.platform_spent || 0) * VK_VAT, 2) : "—",
    leadForms: has ? vkNumber((r.lead_form_spent || 0) * VK_VAT, 2) : "—",
    messages: has
      ? vkNumber(Math.max(0, (r.platform_spent || 0) - (r.lead_form_spent || 0)) * VK_VAT, 2)
      : "—",
    sortValue: has ? r.platform_spent || 0 : -1,
  };
}

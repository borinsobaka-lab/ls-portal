/**
 * «Реестр Авито» — расчёт их avito_register_page (app.py): расход и клики
 * кампаний из Авито, заявки — сделки amoCRM с UTM Авито (заявка креатива
 * — по utm_medium / utm_campaign / utm_content, только если такой набор UTM
 * есть ровно у одной кампании), план периода — месячные планы
 * пропорционально дням (их plan_metrics_for_period). Данные — RPC
 * an_avito_register (db/migrations/2026-10-30_zzzzzzzzzzz_analytics_avito.sql).
 *
 * Числа — с их округлением; разделитель разрядов — пробел везде (у них в
 * кликах и бюджете — запятая).
 */
import { vkNumber } from "../vk/view";
import { wholeMoney } from "../vk/register";
import { avitoPlansForPeriod, type AvitoPlan } from "./rules";

export type AvitoRegisterRow = {
  account_id: number;
  brand: string;
  city: string;
  campaign_id: string;
  campaign_name: string;
  shows: number;
  clicks: number;
  spent: number;
};
export type AvitoRegisterEntity = {
  account_id: number;
  entity_type: "groups" | "creatives";
  entity_id: string;
  parent_campaign_id: string;
  parent_group_id: string;
  name: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
};
export type AvitoLeadRow = {
  brand: string;
  city: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  attribution: "utm" | "source";
  leads: number;
  qualified: number;
  booked: number;
  attended: number;
  paid: number;
};
export type AvitoSourceLead = {
  brand: string;
  city: string;
  amo_lead_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
};
export type AvitoRegisterPayload = {
  from: string;
  to: string;
  accounts: { id: number; name: string; brand: string; city: string }[];
  rows: AvitoRegisterRow[];
  entities: AvitoRegisterEntity[];
  leads: AvitoLeadRow[];
  source_leads: AvitoSourceLead[];
  plans: AvitoPlan[];
};

export type AvitoCreativeLine = {
  name: string;
  utmCampaign: string;
  utmContent: string;
  leads: number;
  qualified: number;
};
export type AvitoGroupLine = { name: string; creatives: AvitoCreativeLine[] };
export type AvitoCampaignLine = {
  key: string;
  name: string;
  leads: number;
  cpl: string;
  clicks: string;
  spent: string;
  groups: AvitoGroupLine[];
};
export type AvitoAccountLine = {
  id: number;
  name: string;
  campaigns: AvitoCampaignLine[];
  clicks: string;
  spent: string;
};
export type AvitoTone = "good" | "warning";
export type AvitoCityBlock = {
  key: string;
  title: string;
  cabinets: string;
  plan: string;
  fact: { text: string; pill: { label: string; tone: AvitoTone } } | null;
  cpl: { text: string; pill: { label: string; tone: AvitoTone } } | null;
  clicks: string;
  spent: string;
  unmatched: number;
  sourceLeads: AvitoSourceLead[];
  accounts: AvitoAccountLine[];
};
export type AvitoRegisterView = {
  spent: string;
  clicks: string;
  leads: number;
  cpl: string;
  cities: AvitoCityBlock[];
};

export const AVITO_REGISTER_TEXT = {
  lead: "Сначала показаны итоговые цифры города. Раскройте город, затем РК — внутри будут группы и креативы с UTM.",
  empty: "Статистика ещё не загружена. Загрузите историю в разделе «Кабинеты Авито».",
  group: "Группа; расход Авито сейчас возвращает на уровне кампании",
  noCreatives: "Креативы пока не загружены.",
  noStructure: "Структура не загружена. Нажмите «Обновить структуру».",
  unmatched: (n: number) =>
    `${n} заявка определена по источнику «Авито Реклама», но пока без сохранённых UTM — в РК не распределена.`,
  showUtms: (n: number) => `Показать UTM заявок (${n})`,
};

const clicksText = (n: number) => vkNumber(n, 0);
const key = (...parts: (string | number)[]) => JSON.stringify(parts);

/** Их f"{v:,.0f} ₽" (CPL — с пробелами, как у них). */
const cplText = (spent: number, leads: number) => (leads ? wholeMoney(spent / leads) : "—");

/** Расчёт страницы — построчно их avito_register_page. */
export function avitoRegisterView(p: AvitoRegisterPayload): AvitoRegisterView {
  // Их lead_map: последняя строка набора UTM (у «utm» и «source» — «utm»).
  const leadMap = new Map<string, AvitoLeadRow>();
  for (const l of p.leads) {
    leadMap.set(key(l.brand, l.city, l.utm_medium, l.utm_campaign, l.utm_content), l);
  }
  const accounts = new Map(p.accounts.map((a) => [a.id, a]));
  const grouped = new Map<number, AvitoRegisterRow[]>();
  for (const r of p.rows) {
    const list = grouped.get(r.account_id) ?? [];
    list.push(r);
    grouped.set(r.account_id, list);
  }
  let totalSpent = 0;
  let totalClicks = 0;
  for (const r of p.rows) {
    totalSpent += Number(r.spent || 0);
    totalClicks += Number(r.clicks || 0);
  }
  const totalLeads = p.leads.reduce((s, l) => s + Number(l.leads || 0), 0);

  // Структура: дети по родителю, у креатива — кампания его группы; набор UTM
  // считается заявкой РК, только если он ровно у одной кампании.
  const entitiesOf = new Map<number, AvitoRegisterEntity[]>();
  for (const e of p.entities) {
    const list = entitiesOf.get(e.account_id) ?? [];
    list.push(e);
    entitiesOf.set(e.account_id, list);
  }
  const children = new Map<number, Map<string, AvitoRegisterEntity[]>>();
  const targets = new Map<string, Set<string>>();
  for (const [accountId, account] of accounts) {
    const kids = new Map<string, AvitoRegisterEntity[]>();
    const groupCampaign = new Map<string, string>();
    for (const e of entitiesOf.get(accountId) ?? []) {
      if (e.entity_type === "groups") {
        const list = kids.get(e.parent_campaign_id) ?? [];
        list.push(e);
        kids.set(e.parent_campaign_id, list);
        groupCampaign.set(e.entity_id, e.parent_campaign_id);
      } else {
        const list = kids.get(e.parent_group_id) ?? [];
        list.push(e);
        kids.set(e.parent_group_id, list);
        const campaign = groupCampaign.get(e.parent_group_id) ?? "";
        if (campaign && (e.utm_medium || e.utm_campaign || e.utm_content)) {
          const k = key(account.brand, account.city, e.utm_medium, e.utm_campaign, e.utm_content);
          const set = targets.get(k) ?? new Set<string>();
          set.add(key(accountId, campaign));
          targets.set(k, set);
        }
      }
    }
    children.set(accountId, kids);
  }
  const unique = new Map<string, string>();
  for (const [k, set] of targets) if (set.size === 1) unique.set(k, [...set][0]);

  const sections = new Map<string, AvitoAccountLine[]>();
  for (const [accountId, campaigns] of grouped) {
    const account = accounts.get(accountId);
    if (!account) continue;
    const kids = children.get(accountId) ?? new Map<string, AvitoRegisterEntity[]>();
    const lines: AvitoCampaignLine[] = [];
    for (const c of campaigns) {
      const target = key(accountId, c.campaign_id);
      const utms = new Set<string>();
      for (const group of kids.get(c.campaign_id) ?? []) {
        for (const cr of kids.get(group.entity_id) ?? []) {
          if (cr.utm_medium || cr.utm_campaign || cr.utm_content) {
            utms.add(
              key(account.brand, account.city, cr.utm_medium, cr.utm_campaign, cr.utm_content),
            );
          }
        }
      }
      let leadCount = 0;
      for (const k of utms) {
        if (unique.get(k) === target && leadMap.has(k))
          leadCount += Number(leadMap.get(k)!.leads || 0);
      }
      const spent = Number(c.spent || 0);
      lines.push({
        key: target,
        name: c.campaign_name || c.campaign_id,
        leads: leadCount,
        cpl: cplText(spent, leadCount),
        clicks: clicksText(Number(c.clicks || 0)),
        spent: wholeMoney(spent),
        groups: (kids.get(c.campaign_id) ?? []).map((group) => ({
          name: group.name || group.entity_id,
          creatives: (kids.get(group.entity_id) ?? []).map((cr) => {
            const k = key(
              account.brand,
              account.city,
              cr.utm_medium,
              cr.utm_campaign,
              cr.utm_content,
            );
            const lead = unique.get(k) === target ? leadMap.get(k) : undefined;
            return {
              name: cr.name || cr.entity_id,
              utmCampaign: cr.utm_campaign || "—",
              utmContent: cr.utm_content || "—",
              leads: lead ? Number(lead.leads || 0) : 0,
              qualified: lead ? Number(lead.qualified || 0) : 0,
            };
          }),
        })),
      });
    }
    let accountSpent = 0;
    let accountClicks = 0;
    for (const c of campaigns) {
      accountSpent += Number(c.spent || 0);
      accountClicks += Number(c.clicks || 0);
    }
    const cityKey = key(account.brand, account.city);
    const list = sections.get(cityKey) ?? [];
    list.push({
      id: accountId,
      name: account.name,
      campaigns: lines,
      clicks: clicksText(accountClicks),
      spent: wholeMoney(accountSpent),
    });
    sections.set(cityKey, list);
  }

  const plans = avitoPlansForPeriod(p.from, p.to, p.plans);
  const cities: AvitoCityBlock[] = [];
  for (const [cityKey, accountLines] of sections) {
    const [brand, city] = JSON.parse(cityKey) as [string, string];
    const ids = [...grouped.keys()].filter((id) => {
      const a = accounts.get(id);
      return a && a.brand === brand && a.city === city;
    });
    const cityLeads = p.leads.filter((l) => l.brand === brand && l.city === city);
    const leadCount = cityLeads.reduce((s, l) => s + Number(l.leads || 0), 0);
    let spent = 0;
    let clicks = 0;
    for (const id of ids) {
      for (const c of grouped.get(id) ?? []) {
        spent += Number(c.spent || 0);
        clicks += Number(c.clicks || 0);
      }
    }
    const cpl = cplText(spent, leadCount);
    const plan = plans.get(key(brand, city));
    const planApplications = plan ? Math.ceil(plan.applications_plan) : 0;
    let fact: AvitoCityBlock["fact"] = null;
    let cplFact: AvitoCityBlock["cpl"] = null;
    if (plan) {
      const delta = leadCount - planApplications;
      fact = {
        text: `${leadCount} из ${planApplications}`,
        pill:
          delta >= 0
            ? { label: `+${delta} сверх`, tone: "good" }
            : { label: `Нужно ${-delta}`, tone: "warning" },
      };
      const ok = !leadCount || spent / leadCount <= plan.target_cpl;
      cplFact = {
        text: `${wholeMoney(plan.target_cpl)} / ${cpl}`,
        pill: ok ? { label: "В норме", tone: "good" } : { label: "Выше цели", tone: "warning" },
      };
    }
    cities.push({
      key: cityKey,
      title: `${city} · ${brand}`,
      cabinets: `${ids.length} кабинет${ids.length !== 1 ? "ов" : ""}`,
      plan: plan ? String(planApplications) : "—",
      fact,
      cpl: cplFact,
      clicks: clicksText(clicks),
      spent: wholeMoney(spent),
      unmatched: cityLeads
        .filter((l) => l.attribution === "source")
        .reduce((s, l) => s + Number(l.leads || 0), 0),
      sourceLeads: p.source_leads.filter((l) => l.brand === brand && l.city === city),
      accounts: accountLines,
    });
  }
  return {
    spent: wholeMoney(totalSpent),
    clicks: clicksText(totalClicks),
    leads: totalLeads,
    cpl: cplText(totalSpent, totalLeads),
    cities,
  };
}

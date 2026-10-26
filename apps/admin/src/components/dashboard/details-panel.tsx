import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Phone, X } from "lucide-react";

import { ClientNameLink } from "@/components/client-name-link";
import { Button } from "@/components/ui/button";
import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { SearchInput } from "@/components/ui/search-input";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { formatPhoneDisplay } from "@/lib/contacts";
import {
  countText,
  type DetailRow,
  type DetailTone,
  type DetailsSpec,
} from "@/lib/dashboard-details";
import { formatStat } from "@/lib/dashboard-stats";
import { formatDate, formatNumber, sanitizeSearch } from "@/lib/format";
import { plural } from "@/lib/payroll";
import { cn } from "@/lib/utils";

/**
 * Подробный отчёт в окне плитки дашборда (справа от графика или один, у
 * «сейчас»-плиток): кто стоит за цифрой — клиенты с телефоном и ссылкой на
 * карточку, что купили, сколько и когда. Отдельным чанком (lazy в
 * stat-cards.tsx): карточка клиента тянет формы и libphonenumber-js, а
 * дашборд открывается первым после входа.
 */

type Person = {
  id: string;
  userId: string | null;
  name: string;
  phone: string | null;
  crmLink: string | null;
};

/** Список id кусками: длинный `in.(…)` не влезает в адрес запроса. */
function chunks<T>(items: T[], size = 100) {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Имена и телефоны клиентов строк — одним запросом на список (строки несут
 * только id карточки или учётной записи). Чужие карточки RLS не отдаст —
 * у строки останется имя из журнала.
 */
function usePeople(rows: DetailRow[] | undefined) {
  const ids = useMemo(() => {
    const clientIds = new Set<string>();
    const userIds = new Set<string>();
    for (const r of rows ?? []) {
      if (r.clientId) clientIds.add(r.clientId);
      else if (r.userId) userIds.add(r.userId);
    }
    return { clientIds: [...clientIds].sort(), userIds: [...userIds].sort() };
  }, [rows]);
  return useQuery({
    queryKey: ["dashboard", "people", ids.clientIds.join(","), ids.userIds.join(",")],
    queryFn: async () => {
      const columns = "id, user_id, first_name, last_name, full_name, phone, crm_link";
      const pages = await Promise.all([
        ...chunks(ids.clientIds).map((part) =>
          supabase.from("clients").select(columns).in("id", part),
        ),
        ...chunks(ids.userIds).map((part) =>
          supabase.from("clients").select(columns).in("user_id", part),
        ),
      ]);
      const byClient = new Map<string, Person>();
      const byUser = new Map<string, Person>();
      for (const { data, error } of pages) {
        if (error) throw new Error(error.message);
        for (const r of data ?? []) {
          const person: Person = {
            id: String(r.id),
            userId: (r.user_id as string | null) ?? null,
            name:
              [r.last_name, r.first_name].filter(Boolean).join(" ").trim() ||
              String(r.full_name ?? "—"),
            phone: (r.phone as string | null) ?? null,
            crmLink: (r.crm_link as string | null) ?? null,
          };
          byClient.set(person.id, person);
          if (person.userId) byUser.set(person.userId, person);
        }
      }
      return { byClient, byUser };
    },
    enabled: ids.clientIds.length + ids.userIds.length > 0,
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить клиентов отчёта" },
  });
}

const DETAIL_TONE: Record<DetailTone, StatusTone> = {
  good: "positive",
  bad: "negative",
  warn: "warning",
  muted: "neutral",
};

/** Сколько строк рисуем сразу: длинный список — «Показать ещё». */
const PAGE = 100;

export default function DetailsPanel({
  fit = false,
  spec,
  rows,
  loading,
  error,
  range,
}: {
  /**
   * Рядом с графиком: на широком экране — во всю высоту ячейки (её задаёт
   * график), строки прокручиваются внутри. Без него — список целиком.
   */
  fit?: boolean;
  spec: DetailsSpec;
  /** Уже отобранные и упорядоченные строки (lib/dashboard-details.ts, detailRows). */
  rows: DetailRow[] | undefined;
  loading: boolean;
  error: boolean;
  /** За что список: период дашборда или выбранный столбец графика (его можно сбросить). */
  range?: { label: string; onReset?: () => void };
}) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const people = usePeople(rows);

  const resolved = useMemo(() => {
    const map = people.data;
    return (rows ?? []).map((row) => {
      const person =
        (row.clientId && map?.byClient.get(row.clientId)) ||
        (row.userId && map?.byUser.get(row.userId)) ||
        null;
      return { row, person, name: person?.name ?? row.name ?? null };
    });
  }, [rows, people.data]);

  const term = sanitizeSearch(search).toLowerCase();
  const digits = term.replace(/\D/g, "");
  const shown = term
    ? resolved.filter(
        ({ row, person, name }) =>
          (name ?? "").toLowerCase().includes(term) ||
          (row.title ?? "").toLowerCase().includes(term) ||
          (digits.length >= 3 && (person?.phone ?? "").replace(/\D/g, "").includes(digits)),
      )
    : resolved;

  const total =
    spec.totalLabel && shown.length ? shown.reduce((s, x) => s + (x.row.value ?? 0), 0) : undefined;
  const formatValue = (v: number) =>
    spec.valueUnit
      ? `${formatNumber(v)} ${plural(v, spec.valueUnit)}`
      : formatStat(spec.format ?? "number", v);

  return (
    <section
      className={cn("flex min-h-0 flex-col rounded-lg border", fit && "lg:absolute lg:inset-0")}
    >
      <div className="space-y-2 border-b p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-semibold">{spec.title}</h3>
          {rows && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {countText(shown.length, spec.unit)}
              {total !== undefined && (
                <>
                  {" · "}
                  {spec.totalLabel} {formatValue(total)}
                </>
              )}
            </span>
          )}
        </div>
        {range && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="first-letter:uppercase">{range.label}</span>
            {range.onReset && (
              <Button variant="ghost" size="xs" onClick={range.onReset}>
                <X /> весь период
              </Button>
            )}
          </div>
        )}
        <SearchInput value={search} onChange={setSearch} placeholder="Поиск по списку" />
      </div>

      <div className={cn("min-h-0 flex-1", fit && "lg:overflow-y-auto")}>
        {loading ? (
          <div className="space-y-px p-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : error ? (
          <Empty text="Не удалось загрузить список" />
        ) : shown.length === 0 ? (
          <Empty text={term ? "Ничего не найдено" : spec.empty} />
        ) : (
          <ul className="divide-y">
            {shown.slice(0, limit).map(({ row, person, name }) => (
              <li key={row.key} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                    <RowName
                      row={row}
                      name={name}
                      crmLink={person?.crmLink ?? null}
                      loading={people.isLoading}
                    />
                    {person?.phone && (
                      <a
                        href={`tel:${person.phone}`}
                        className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Phone className="size-3" />
                        {formatPhoneDisplay(person.phone)}
                      </a>
                    )}
                  </div>
                  {(row.title || row.note) && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[row.title, row.note].filter(Boolean).join(" · ")}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
                  {row.value !== undefined && (
                    <span
                      className={cn(
                        "text-sm font-semibold tabular-nums",
                        row.value < 0 && "text-rose-600",
                      )}
                    >
                      {formatValue(row.value)}
                    </span>
                  )}
                  {!spec.noDate && (
                    <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {spec.dateLabel && `${spec.dateLabel} `}
                      {row.dateText ?? formatDate(row.date)}
                    </span>
                  )}
                  {row.badge && (
                    <StatusChip tone={DETAIL_TONE[row.badge.tone]}>{row.badge.text}</StatusChip>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {shown.length > limit && (
          <div className="border-t p-2 text-center">
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setLimit((l) => l + PAGE)}
            >
              Показать ещё {formatNumber(Math.min(PAGE, shown.length - limit))}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

function RowName({
  row,
  name,
  crmLink,
  loading,
}: {
  row: DetailRow;
  name: string | null;
  /** Ссылка amoCRM из запроса имён: строки не дёргают базу каждая за своей. */
  crmLink: string | null;
  loading: boolean;
}) {
  if (!name && loading) return <Skeleton className="h-4 w-32" />;
  const label = name ?? (row.clientId ? "Клиент удалён" : "Без клиента");
  if (row.clientId || row.userId)
    return (
      <ClientNameLink
        clientId={row.clientId}
        userId={row.userId}
        crmLink={crmLink}
        className="truncate"
      >
        {label}
      </ClientNameLink>
    );
  return <span className="font-medium">{label}</span>;
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center p-4 text-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}

import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { DataPagination, usePagination } from "@/components/data-pagination";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarReset, ToolbarSearch } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { supabase } from "@/integrations/supabase/client";
import { invalidateAccess } from "@/lib/access/data";
import { ANALYTICS_KEY } from "@/lib/analytics/data";
import { importLegacyPerson } from "@/lib/analytics/legacy.functions";
import {
  LEGACY_KIND_LABEL,
  LEGACY_STARTER_ROLES,
  legacyEmail,
  legacyImportProblem,
  legacyRights,
  legacyRolePlan,
  unknownGrants,
  type LegacyKind,
  type LegacyPerson,
} from "@/lib/analytics/legacy-people";
import { formatDateTime } from "@/lib/format";
import { unwrap } from "@/lib/query";

type StarterRole = {
  id: string;
  name: string;
  system_key: string;
  access_role_permissions: { perm_key: string }[];
};

const ALL = "all";
const TIPS = {
  kind: "Тип на старом портале: администратор, партнёр (есть города), таргетолог, лид-менеджер или сотрудник.",
  access: "Выданные отчёты старого портала; у партнёра — его города.",
  role: "Что получит человек: стартовая роль «Аналитики», если его набор прав совпал с ней, иначе — личные права с тем же набором.",
  seen: "Последний раз на старом портале.",
};

/**
 * «Синхронизация» → «Пользователи со старого портала» (ANALYTICS_PLAN.md,
 * §10): люди приходят зеркалом (an_legacy_users); суперадминистратор
 * переносит их в «Пользователей» — учётная запись (вход по коду из письма),
 * роль по типу и выданным отчётам, города и карточка партнёра. Один раз:
 * дальше доступ в двух порталах ведётся независимо.
 */
export function LegacyPeopleSection({ canImport }: { canImport: boolean }) {
  const qc = useQueryClient();
  const importFn = useServerFn(importLegacyPerson);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<LegacyKind | typeof ALL>(ALL);
  const [state, setState] = useState<"todo" | "done" | "all">("todo");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [emails, setEmails] = useState<Record<number, string>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const { data: people, isPending } = useQuery({
    queryKey: [ANALYTICS_KEY, "legacy-people"],
    queryFn: () => unwrap<LegacyPerson[]>(supabase.rpc("an_legacy_people")),
    meta: { errorMessage: "Не удалось загрузить людей старого портала" },
  });
  const { data: starters } = useQuery({
    queryKey: [ANALYTICS_KEY, "starter-roles"],
    queryFn: () =>
      unwrap<StarterRole[]>(
        supabase
          .from("access_roles")
          .select("id, name, system_key, access_role_permissions(perm_key)")
          .in("system_key", [...LEGACY_STARTER_ROLES]),
      ),
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить роли «Аналитики»" },
  });

  const starterRights = useMemo(
    () =>
      Object.fromEntries(
        (starters ?? []).map((r) => [
          r.system_key,
          r.access_role_permissions.map((p) => p.perm_key),
        ]),
      ),
    [starters],
  );
  const starterName = (key: string) =>
    starters?.find((r) => r.system_key === key)?.name ?? "Стартовая роль";

  const emailOf = (p: LegacyPerson) => {
    const typed = emails[p.id]?.trim().toLowerCase();
    return typed ? legacyEmail(typed) : legacyEmail(p.login);
  };
  const problemOf = (p: LegacyPerson) => legacyImportProblem(p, emailOf(p));

  const needle = q.trim().toLowerCase();
  const filtered = (people ?? []).filter(
    (p) =>
      (kind === ALL || p.kind === kind) &&
      (state === "all" || (state === "done") === !!p.user_id) &&
      (!needle ||
        p.full_name.toLowerCase().includes(needle) ||
        p.login.toLowerCase().includes(needle) ||
        p.position.toLowerCase().includes(needle) ||
        p.cities.some((c) => c.toLowerCase().includes(needle))),
  );
  const sort = useTableSort<LegacyPerson>({
    name: (p) => p.full_name,
    kind: (p) => LEGACY_KIND_LABEL[p.kind],
    seen: (p) => p.last_seen_at,
  });
  const filterKey = `${needle}|${kind}|${state}|${sort.key}`;
  const pg = usePagination(sort.apply(filtered), undefined, filterKey, "analytics-legacy-people");
  const selectable = filtered.filter((p) => !problemOf(p));
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.id));
  const filtersActive = !!needle || kind !== ALL || state !== "todo";
  const counts = {
    total: people?.length ?? 0,
    done: (people ?? []).filter((p) => p.user_id).length,
    active: (people ?? []).filter((p) => p.is_active).length,
  };

  const toggle = (id: number, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const runImport = async () => {
    const queue = (people ?? []).filter((p) => selected.has(p.id) && !problemOf(p));
    if (queue.length === 0) return;
    setProgress({ done: 0, total: queue.length });
    const failed: Record<number, string> = {};
    let ok = 0;
    for (const [i, p] of queue.entries()) {
      try {
        const typed = emails[p.id]?.trim();
        await importFn({ data: { legacy_id: p.id, email: typed ? typed.toLowerCase() : null } });
        ok += 1;
      } catch (e) {
        failed[p.id] = (e as Error).message;
      }
      setProgress({ done: i + 1, total: queue.length });
    }
    setErrors(failed);
    setSelected(new Set(Object.keys(failed).map(Number)));
    setProgress(null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: [ANALYTICS_KEY, "legacy-people"] }),
      invalidateAccess(qc),
    ]);
    if (ok) toast.success(`Перенесено: ${ok}`);
    if (Object.keys(failed).length) toast.error(`Не перенесено: ${Object.keys(failed).length}`);
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Пользователи со старого портала</h2>
      <InfoNote>
        Люди приходят со старого портала вместе с данными. Перенос — один раз: человек получает
        учётную запись этого портала (вход по коду из письма на его почту), роль по своему типу и
        выданным отчётам, города и карточку партнёра. Дальше доступ в двух порталах ведётся
        независимо: правки на старом портале сюда не переносятся, роли меняются в «Пользователях и
        ролях».
        {!canImport && " Переносит людей суперадминистратор."}
      </InfoNote>
      {people && (
        <p className="text-sm text-muted-foreground">
          Всего: {counts.total} · активны: {counts.active} · перенесены: {counts.done}
        </p>
      )}
      <TableToolbar>
        <ToolbarSearch value={q} onChange={setQ} placeholder="Имя, логин, должность или город" />
        <Select value={kind} onValueChange={(v) => setKind(v as LegacyKind | typeof ALL)}>
          <SelectTrigger aria-label="Тип" className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Все типы</SelectItem>
            {(Object.keys(LEGACY_KIND_LABEL) as LegacyKind[]).map((k) => (
              <SelectItem key={k} value={k}>
                {LEGACY_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SegmentedControl
          aria-label="Перенос"
          value={state}
          onChange={setState}
          options={[
            { value: "todo", label: "Не перенесены" },
            { value: "done", label: "Перенесены" },
            { value: "all", label: "Все" },
          ]}
        />
        <ToolbarReset
          active={filtersActive}
          onReset={() => {
            setQ("");
            setKind(ALL);
            setState("todo");
          }}
        />
        {canImport && (
          <Button
            className="ml-auto"
            disabled={selected.size === 0 || !!progress}
            onClick={() => void runImport()}
          >
            {progress
              ? `Переносим ${progress.done} из ${progress.total}…`
              : `Перенести отмеченных${selected.size ? ` (${selected.size})` : ""}`}
          </Button>
        )}
      </TableToolbar>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {canImport && (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Отметить всех, кого можно перенести"
                    checked={allSelected}
                    disabled={selectable.length === 0 || !!progress}
                    onCheckedChange={(on) =>
                      setSelected(on ? new Set(selectable.map((p) => p.id)) : new Set())
                    }
                  />
                </TableHead>
              )}
              <TableHead {...sort.head("name")}>Человек</TableHead>
              <TableHead tip={TIPS.kind} {...sort.head("kind")}>
                Тип и должность
              </TableHead>
              <TableHead tip={TIPS.access}>Доступ</TableHead>
              <TableHead tip={TIPS.role}>Получит</TableHead>
              <TableHead tip={TIPS.seen} {...sort.head("seen")}>
                Последний вход
              </TableHead>
              <TableHead>Перенос</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableSkeletonRows columns={canImport ? 7 : 6} rows={5} />
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={canImport ? 7 : 6}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {(people ?? []).length === 0
                    ? "Люди старого портала появятся, когда агент на старом сервере пришлёт первые данные."
                    : "Никого не нашлось"}
                </TableCell>
              </TableRow>
            ) : (
              pg.paged.map((p) => {
                const problem = problemOf(p);
                const plan = legacyRolePlan(legacyRights(p), starterRights);
                const unknown = unknownGrants(p);
                const needsEmail = !p.user_id && !legacyEmail(p.login);
                return (
                  <TableRow key={p.id} data-state={selected.has(p.id) ? "selected" : undefined}>
                    {canImport && (
                      <TableCell>
                        <Checkbox
                          aria-label={`Отметить: ${p.full_name}`}
                          disabled={!!problem || !!progress}
                          checked={selected.has(p.id)}
                          onCheckedChange={(on) => toggle(p.id, on === true)}
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="font-medium">{p.full_name}</div>
                      <div className="text-xs text-muted-foreground">{p.login}</div>
                    </TableCell>
                    <TableCell>
                      <div>{LEGACY_KIND_LABEL[p.kind]}</div>
                      {p.position && (
                        <div className="text-xs text-muted-foreground">{p.position}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.role === "admin"
                        ? "Всё"
                        : p.grants.length
                          ? `Отчётов: ${p.grants.length}`
                          : "Отчётов нет"}
                      {p.cities.length > 0 && (
                        <div className="text-xs text-muted-foreground">{p.cities.join(", ")}</div>
                      )}
                      {unknown.length > 0 && (
                        <div className="text-xs text-amber-700 dark:text-amber-300">
                          Не переносятся: {unknown.join(", ")}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {plan.kind === "starter"
                        ? starterName(plan.systemKey)
                        : `Личные права: ${plan.rights.length}`}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.last_seen_at ? formatDateTime(p.last_seen_at) : "не входил"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.user_id ? (
                        <div className="space-y-1">
                          <StatusChip tone="positive">Перенесён</StatusChip>
                          <Link
                            to="/access/users/$userId"
                            params={{ userId: p.user_id }}
                            className="block text-xs underline-offset-2 hover:underline"
                          >
                            {p.user_name ?? "Карточка"}
                          </Link>
                        </div>
                      ) : !p.is_active ? (
                        <StatusChip tone="neutral">Отключён на старом портале</StatusChip>
                      ) : (
                        <div className="space-y-1">
                          {needsEmail && canImport ? (
                            <Input
                              type="email"
                              aria-label={`Почта: ${p.full_name}`}
                              placeholder="Почта для входа"
                              value={emails[p.id] ?? ""}
                              onChange={(e) =>
                                setEmails((cur) => ({ ...cur, [p.id]: e.target.value }))
                              }
                              className="w-56"
                            />
                          ) : needsEmail ? (
                            <StatusChip tone="warning">Нет почты</StatusChip>
                          ) : p.match_user_id ? (
                            <StatusChip tone="info">
                              {p.match_in_portal
                                ? "Уже в портале — добавим роль"
                                : "Есть учётная запись"}
                            </StatusChip>
                          ) : (
                            <StatusChip tone="neutral">Новый</StatusChip>
                          )}
                          {errors[p.id] && (
                            <div className="text-xs text-destructive">{errors[p.id]}</div>
                          )}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      {people && people.length > 0 && <DataPagination {...pg} />}
    </section>
  );
}

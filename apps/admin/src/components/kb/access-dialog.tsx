import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { SearchableCombobox } from "@/components/searchable-combobox";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckboxOption, FormField, InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { supabase } from "@/integrations/supabase/client";
import { orgPositionsQuery, orgUnitsQuery } from "@/lib/access/data";
import { unitTree } from "@/lib/access/logic";
import {
  addRule,
  inheritedText,
  KB_ACCESS_SUBJECT_LABEL,
  peopleCount,
  removeRule,
  ruleHint,
  ruleKey,
  rulesEqual,
  type KbAccessRule,
  type KbAccessSubject,
  type KbNodeAccess,
} from "@/lib/kb/access-rules";
import { invalidateKb, kbErrorText } from "@/lib/kb/data";
import type { KbTreeNode } from "@/lib/kb/types";
import { isHiddenRole } from "@/lib/launch";
import { unwrap } from "@/lib/query";

const TIPS = {
  mode: "Свой список заменяет список раздела выше: так статью можно открыть и шире раздела, и уже. Редакторы базы и администраторы баз знаний видят всё.",
  unit: "Только руководители и заместители подразделения или все его сотрудники; с подразделениями ниже — и те, кто появится там позже.",
};

const KB_NODE_ACCESS_KEY = "kb_node_access";

type Person = { user_id: string; full_name: string; position_name: string | null };
type Role = { id: string; name: string; system_key: string | null };

/**
 * «Кто видит» раздел, папку или статью — как в Platrum
 * (db/migrations/2026-11-07_kb_section_access.sql): как выше (раздел или
 * база) или свой список — сотрудники, должности, подразделения, роли.
 * Задают редакторы базы и администраторы баз знаний (kb_node_access_save).
 */
export function KbAccessForm({
  baseId,
  node,
  onDone,
}: {
  baseId: string;
  node: KbTreeNode;
  onDone: () => void;
}) {
  const { data: access, isLoading } = useQuery({
    queryKey: [KB_NODE_ACCESS_KEY, node.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("kb_node_access_get", { p_node: node.id });
      if (error) throw error;
      return data as KbNodeAccess;
    },
    meta: { errorMessage: "Не удалось загрузить доступ" },
  });
  const what = node.kind === "folder" ? (node.parent_id ? "папку" : "раздел") : "статью";
  return (
    <>
      <DialogHeader>
        <DialogTitle>Кто видит {what}</DialogTitle>
        <DialogDescription className="line-clamp-2">
          «{node.title || "Без названия"}»
        </DialogDescription>
      </DialogHeader>
      {isLoading || !access ? (
        <DialogBody>
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </DialogBody>
      ) : (
        <AccessEditor baseId={baseId} node={node} access={access} onDone={onDone} />
      )}
    </>
  );
}

function AccessEditor({
  baseId,
  node,
  access,
  onDone,
}: {
  baseId: string;
  node: KbTreeNode;
  access: KbNodeAccess;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [custom, setCustom] = useState(access.custom);
  // Свой список включили — начинаем со списка, который действует сейчас.
  const [rules, setRules] = useState<KbAccessRule[]>(access.rules);
  const [type, setType] = useState<KbAccessSubject>("position");
  const [heads, setHeads] = useState(false);
  const [subunits, setSubunits] = useState(true);
  const [saving, setSaving] = useState(false);

  const { data: people } = useQuery({
    queryKey: ["kb_mention_candidates", baseId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("kb_mention_candidates", { p_base: baseId });
      if (error) throw error;
      return (data ?? []) as Person[];
    },
    staleTime: 60_000,
    meta: { errorMessage: "Не удалось загрузить сотрудников" },
  });
  const { data: units } = useQuery(orgUnitsQuery);
  const { data: positions } = useQuery(orgPositionsQuery);
  const { data: roles } = useQuery({
    queryKey: ["kb_access_roles"],
    queryFn: () =>
      unwrap<Role[]>(
        supabase
          .from("access_roles")
          .select("id, name, system_key")
          .is("personal_user_id", null)
          .order("sort_order")
          .order("name"),
      ),
    select: (rows: Role[]) => rows.filter((r) => !isHiddenRole(r)),
    staleTime: 5 * 60_000,
    meta: { errorMessage: "Не удалось загрузить роли" },
  });

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people ?? []) map.set(`user:${p.user_id}`, p.full_name);
    for (const p of positions ?? []) map.set(`position:${p.id}`, p.name);
    for (const u of units ?? []) map.set(`unit:${u.id}`, u.name);
    for (const r of roles ?? []) map.set(`role:${r.id}`, r.name);
    return map;
  }, [people, positions, units, roles]);

  const options = useMemo(() => {
    const taken = new Set(rules.map(ruleKey));
    const free = <T extends { value: string }>(list: T[]) =>
      list.filter((o) => type === "unit" || !taken.has(`${type}:${o.value}`));
    if (type === "user")
      return free(
        (people ?? []).map((p) => ({
          value: p.user_id,
          label: p.full_name,
          hint: p.position_name ?? undefined,
          searchText: `${p.full_name} ${p.position_name ?? ""}`,
        })),
      );
    if (type === "position")
      return free(
        (positions ?? []).map((p) => ({ value: p.id, label: p.name, searchText: p.name })),
      );
    if (type === "unit")
      return unitTree(units ?? []).map(({ unit, depth }) => ({
        value: unit.id,
        label: `${"  ".repeat(depth)}${unit.name}`,
        searchText: unit.name,
      }));
    return free((roles ?? []).map((r) => ({ value: r.id, label: r.name, searchText: r.name })));
  }, [type, people, positions, units, roles, rules]);

  const changed = custom !== access.custom || (custom && !rulesEqual(rules, access.rules));

  const save = async () => {
    if (!changed) {
      onDone();
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc("kb_node_access_save", {
        p_node: node.id,
        p_custom: custom,
        p_rules: custom ? rules : [],
      });
      if (error) throw error;
      toast.success("Доступ сохранён");
      await Promise.all([
        invalidateKb(qc, baseId),
        qc.invalidateQueries({ queryKey: [KB_NODE_ACCESS_KEY] }),
      ]);
      onDone();
    } catch (e) {
      toast.error(kbErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogForm onSubmit={save}>
      <DialogBody>
        <div className="space-y-4">
          <FormField label="Кто видит" tip={TIPS.mode} htmlFor={null}>
            <SegmentedControl
              aria-label="Кто видит"
              fullWidth
              value={custom ? "custom" : "inherit"}
              onChange={(v) => {
                setCustom(v === "custom");
                // Снова свой — со списком, который сейчас действует.
                if (v === "custom" && !access.custom) setRules(access.rules);
              }}
              options={[
                { value: "inherit", label: node.parent_id ? "Как выше" : "Как в базе" },
                { value: "custom", label: "Свой список" },
              ]}
            />
          </FormField>

          {!custom ? (
            <InfoNote variant="info">
              {access.custom
                ? "Свой список будет удалён, и станет как у раздела выше, а если его нет — как в базе."
                : `${inheritedText(access)} Сейчас видят: ${peopleCount(access.viewers)}.`}
              {!access.custom && access.source_id && access.rules.length > 0 && (
                <span className="mt-2 flex flex-wrap gap-1">
                  {access.rules.map((r) => (
                    <span key={ruleKey(r)} className="rounded-full bg-background px-2 py-0.5">
                      {names.get(ruleKey(r)) ?? KB_ACCESS_SUBJECT_LABEL[r.subject_type]}
                    </span>
                  ))}
                </span>
              )}
            </InfoNote>
          ) : (
            <>
              <div className="space-y-1.5">
                {rules.length === 0 ? (
                  <InfoNote variant="warning">
                    Список пуст — {node.kind === "article" ? "статью" : "раздел"} увидят только
                    редакторы базы и администраторы баз знаний.
                  </InfoNote>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {rules.map((r) => {
                      const key = ruleKey(r);
                      const hint = ruleHint(r);
                      return (
                        <li key={key} className="flex items-center gap-3 px-3 py-2 text-sm">
                          <span className="w-28 shrink-0 text-xs text-muted-foreground">
                            {KB_ACCESS_SUBJECT_LABEL[r.subject_type]}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {names.get(key) ?? "Нет в портале"}
                            </span>
                            {hint && (
                              <span className="block text-xs text-muted-foreground">{hint}</span>
                            )}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Убрать из списка"
                            onClick={() => setRules((list) => removeRule(list, key))}
                          >
                            <X />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <FormField label="Добавить" htmlFor={null}>
                <div className="space-y-2">
                  <SegmentedControl
                    aria-label="Кого добавить"
                    fullWidth
                    value={type}
                    onChange={setType}
                    options={[
                      { value: "position", label: "Должность" },
                      { value: "unit", label: "Подразделение" },
                      { value: "user", label: "Сотрудник" },
                      { value: "role", label: "Роль" },
                    ]}
                  />
                  {type === "unit" && (
                    <div className="space-y-2 rounded-md border p-3">
                      <SegmentedControl
                        aria-label="Кому в подразделении"
                        fullWidth
                        value={heads ? "heads" : "all"}
                        onChange={(v) => setHeads(v === "heads")}
                        options={[
                          { value: "all", label: "Всем сотрудникам" },
                          { value: "heads", label: "Руководителям" },
                        ]}
                      />
                      <CheckboxOption checked={subunits} onCheckedChange={setSubunits}>
                        И в подразделениях ниже
                      </CheckboxOption>
                      <p className="text-xs text-muted-foreground">{TIPS.unit}</p>
                    </div>
                  )}
                  <SearchableCombobox
                    key={`${type}:${rules.length}`}
                    value=""
                    onChange={(id) => {
                      if (!id) return;
                      setRules((list) =>
                        addRule(list, {
                          subject_type: type,
                          subject_id: id,
                          unit_members: heads ? "heads" : "all",
                          with_subunits: subunits,
                        }),
                      );
                    }}
                    placeholder={
                      type === "user"
                        ? "Выберите сотрудника"
                        : type === "position"
                          ? "Выберите должность"
                          : type === "unit"
                            ? "Выберите подразделение"
                            : "Выберите роль"
                    }
                    searchPlaceholder="Поиск"
                    emptyText="Ничего не нашлось"
                    options={options}
                  />
                </div>
              </FormField>
            </>
          )}

          <InfoNote variant="muted">
            Редакторы базы и администраторы баз знаний видят всё. Вложенное без своего списка видят
            так же, как {node.kind === "article" ? "эту статью" : "этот раздел"}. Читатели видят
            только опубликованное.
          </InfoNote>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onDone} disabled={saving}>
          Отмена
        </Button>
        <Button type="submit" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          Сохранить
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

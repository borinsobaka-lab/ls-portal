import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { FileUp, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CheckboxOption, FormField, InfoNote } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { createPortalUser } from "@/lib/access.functions";
import {
  accessCatalogQuery,
  accessRolesQuery,
  accessRpc,
  accessUsersQuery,
  invalidateAccess,
  networkStudiosQuery,
  orgPositionsQuery,
  orgUnitsQuery,
} from "@/lib/access/data";
import {
  buildImportRows,
  IMPORT_COLUMN_LABEL,
  parseTable,
  type ImportColumn,
  type ImportRow,
} from "@/lib/access/import";
import { hasStudioPerms, USER_TYPE_LABEL } from "@/lib/access/logic";
import { cn } from "@/lib/utils";

const EXAMPLE =
  "Фамилия;Имя;Email;Телефон;Тип;Должность;Подразделение;Роль;Клубы собственника\nИванова;Анна;anna@example.ru;+79170000000;Партнёр;Партнёр;;Партнёр — аналитика;Казань Центр";

/**
 * «Импорт из таблицы» в «Пользователях»: CSV или вставка из Excel / Google
 * Таблиц / выгрузки сотрудников Битрикс24. Разбор и сверка со справочниками —
 * lib/access/import.ts; запись — та же серверная функция, что «Добавить»,
 * по одному человеку, затем подразделение и клубы собственника.
 */
export function ImportUsersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl" anchor="top">
        {open && <ImportForm onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const create = useServerFn(createPortalUser);
  const access = useAdminAccess();
  const canStructure = hasRight(access, "structure.manage");
  const { data: users } = useQuery(accessUsersQuery);
  const { data: positions } = useQuery(orgPositionsQuery);
  const { data: units } = useQuery(orgUnitsQuery);
  const { data: roles } = useQuery(accessRolesQuery);
  const { data: catalog } = useQuery(accessCatalogQuery);
  const { data: studios } = useQuery(networkStudiosQuery);
  const [text, setText] = useState("");
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);

  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    return buildImportRows(parseTable(text), {
      positions: positions ?? [],
      units: units ?? [],
      roles: (roles ?? [])
        .filter((r) => !r.grant_problem)
        .map((r) => ({
          id: r.id,
          name: r.name,
          network: !hasStudioPerms(r.permissions, catalog ?? []),
        })),
      clubs: (studios ?? []).map((s) => ({ id: s.id, name: s.name, city: s.city })),
      users: users ?? [],
    });
  }, [text, positions, units, roles, catalog, studios, users]);

  const rows = parsed?.rows ?? [];
  const importable = rows.filter((r) => !r.error && !(skipDuplicates && r.duplicate));
  const found = parsed
    ? (Object.keys(parsed.columns) as ImportColumn[]).map((c) => IMPORT_COLUMN_LABEL[c])
    : [];
  const noNames =
    parsed &&
    parsed.columns.full_name === undefined &&
    (parsed.columns.last_name === undefined || parsed.columns.first_name === undefined);

  const readFile = async (file: File) => {
    const buf = await file.arrayBuffer();
    // Excel сохраняет CSV в UTF-8 или в Windows-1251 — пробуем по очереди.
    let content = new TextDecoder("utf-8").decode(buf);
    if (content.includes("�")) content = new TextDecoder("windows-1251").decode(buf);
    setText(content);
  };

  const run = async () => {
    if (importable.length === 0) {
      toast.error("Нечего импортировать");
      return;
    }
    let ok = 0;
    const failed: string[] = [];
    for (const [i, r] of importable.entries()) {
      setProgress(`${i + 1} из ${importable.length}`);
      try {
        const res = await create({
          data: {
            first_name: r.first_name,
            last_name: r.last_name,
            email: r.email || null,
            phone: r.phone || undefined,
            user_type: r.user_type,
            position_id: r.position_id,
            access_until: null,
            avatar_url: null,
            assignments: r.role_ids.map((role_id) => ({
              role_id,
              scope_type: "all" as const,
              scope_ids: [],
            })),
          },
        });
        if (canStructure && r.unit_id) {
          await accessRpc("org_member_set", {
            p_unit: r.unit_id,
            p_user: res.user_id,
            p_role: "member",
          });
        }
        if (canStructure && r.club_ids.length) {
          await accessRpc("org_user_studios_set", { p_user: res.user_id, p_studios: r.club_ids });
        }
        ok++;
      } catch (e) {
        const message = e instanceof Error ? e.message : "ошибка";
        failed.push(
          `Строка ${r.line}: ${/^already_in_portal:/.test(message) ? "уже в портале" : message}`,
        );
      }
    }
    setProgress(null);
    await invalidateAccess(qc);
    if (failed.length) {
      toast.error(`Добавлено ${ok}, не получилось ${failed.length}`, {
        description: failed.slice(0, 6).join("\n"),
        duration: 15_000,
      });
    } else {
      toast.success(`Добавлено: ${ok}`);
    }
    onDone();
  };

  const saving = progress !== null;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Импорт пользователей</DialogTitle>
        <DialogDescription>
          Таблица с заголовками в первой строке: файл CSV или текст, скопированный из Excel, Google
          Таблиц или выгрузки сотрудников Битрикс24.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={run}>
        <DialogBody>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <label className="cursor-pointer">
                  <FileUp /> Выбрать файл CSV
                  <input
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/plain"
                    className="sr-only"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void readFile(file);
                      e.target.value = "";
                    }}
                  />
                </label>
              </Button>
              <span className="text-xs text-muted-foreground">или вставьте таблицу ниже</span>
            </div>
            <FormField
              label="Таблица"
              tip="Колонки узнаются по заголовку: Фамилия, Имя (или ФИО), Email, Телефон, Тип, Должность, Подразделение, Роль, Клубы собственника. Остальные пропускаются."
            >
              <Textarea
                rows={5}
                value={text}
                placeholder={EXAMPLE}
                className="font-mono text-xs"
                onChange={(e) => setText(e.target.value)}
              />
            </FormField>
            <InfoNote>
              Должности, подразделения, роли и клубы ищутся по названию — заведите их заранее. Роли
              из таблицы — только общие для сети (без прав в клубе), на всю сеть. Без почты человек
              будет добавлен, но войти не сможет, пока почту не впишут в карточке.
              {!canStructure &&
                " Подразделения и клубы собственника заполнит тот, у кого право «Оргструктура и сеть»."}
            </InfoNote>
            {parsed && (
              <>
                <p className="text-sm">
                  <span className="text-muted-foreground">Узнаны колонки: </span>
                  {found.length ? found.join(", ") : "ни одной"}
                </p>
                {noNames && (
                  <InfoNote variant="warning">
                    Нет колонок «Фамилия» и «Имя» (или «ФИО») — проверьте первую строку.
                  </InfoNote>
                )}
                <CheckboxOption checked={skipDuplicates} onCheckedChange={setSkipDuplicates}>
                  Пропускать тех, кто похож на уже заведённых (та же почта, телефон или фамилия и
                  имя)
                </CheckboxOption>
                <PreviewTable rows={rows} skipDuplicates={skipDuplicates} />
              </>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving || importable.length === 0}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? `Добавляем… ${progress}` : `Добавить: ${importable.length}`}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

function PreviewTable({ rows, skipDuplicates }: { rows: ImportRow[]; skipDuplicates: boolean }) {
  const errors = rows.filter((r) => r.error).length;
  const dups = rows.filter((r) => !r.error && r.duplicate).length;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Строк: {rows.length}
        {errors > 0 && ` · с ошибкой: ${errors}`}
        {dups > 0 && ` · похожи на заведённых: ${dups}`}
      </p>
      <div className="max-h-80 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted text-left">
            <tr>
              <th className="px-2 py-1.5 font-medium">Стр.</th>
              <th className="px-2 py-1.5 font-medium">Человек</th>
              <th className="px-2 py-1.5 font-medium">Тип</th>
              <th className="px-2 py-1.5 font-medium">Замечания</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => {
              const skipped = !!r.error || (skipDuplicates && !!r.duplicate);
              return (
                <tr key={r.line} className={cn(skipped && "text-muted-foreground")}>
                  <td className="px-2 py-1.5 align-top">{r.line}</td>
                  <td className="px-2 py-1.5 align-top">
                    <div className="font-medium">
                      {[r.last_name, r.first_name].filter(Boolean).join(" ") || "—"}
                    </div>
                    <div>{[r.email || "без почты", r.phone].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    {r.user_type ? USER_TYPE_LABEL[r.user_type] : "—"}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    {r.error && <div className="text-destructive">{r.error} — пропущена</div>}
                    {!r.error && r.duplicate && (
                      <div className="text-amber-700 dark:text-amber-300">
                        {r.duplicate}
                        {skipDuplicates ? " — пропущена" : ""}
                      </div>
                    )}
                    {r.warnings.map((w) => (
                      <div key={w}>{w}</div>
                    ))}
                    {!r.error && !r.duplicate && r.warnings.length === 0 && "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

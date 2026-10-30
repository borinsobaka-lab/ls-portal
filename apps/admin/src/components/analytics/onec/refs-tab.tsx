import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Pencil, Plus, Upload } from "lucide-react";
import { toast } from "sonner";

import { useConfirm } from "@/components/confirm-dialog";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { TableSkeletonRows } from "@/components/skeletons";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
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
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  downloadOnecRef,
  formatMsk,
  ONEC_REF_TITLES,
  onecErrorText,
  onecKey,
  onecRefQuery,
  readOnecRefFile,
  type OnecRefInfo,
} from "@/lib/analytics/onec-page";
import {
  ONEC_REF_COLUMNS,
  ONEC_REF_FILES,
  type NomenclatureRefRow,
  type OnecRefKind,
  type OnecRefRow,
} from "@/lib/analytics/onec/refs";
import { BASE_DESIGNATIONS, CLOSED, OPEN } from "@/lib/analytics/onec/rules";
import { formatNumber } from "@/lib/format";
import { unwrap } from "@/lib/query";

type Row = Record<string, string | null>;

/** Колонки таблицы (остальные — в окне правки). */
const TABLE_COLUMNS: Record<OnecRefKind, string[]> = {
  studios: ["studio", "status", "city", "partner", "comment"],
  nomenclature: ["code", "names", "category", "direction"],
  break_even: [
    "direction",
    "source_city",
    "source_partner",
    "amount",
    "board_city",
    "match_status",
  ],
};

const INTRO: Record<OnecRefKind, string> = {
  studios:
    "Студии 1С: статус («Открыта» / «Закрыта») и город. Студия выручки без справочника или без статуса останавливает обработку — как у них.",
  nomenclature:
    "Каждая обработка пересобирает справочник по выгрузкам продаж; категории («Обозначение») сохраняются, новые выбираются в окне «Новые номенклатуры».",
  break_even:
    "Точка 0 — месячная цель города для «Выручки» и «Мой город». Учитываются строки «Lady Stretch»: «Точка 0 в месяц» по «Городу для борда».",
};

const SOURCE_TEXT = { import: "из файла", edit: "вручную", run: "обработкой" } as const;

const header = (ref: OnecRefKind, key: string) =>
  ONEC_REF_COLUMNS[ref].find((c) => c.key === key)?.header ?? key;

/**
 * Справочник обработчика — как их файл в Excel: просмотр, поиск, правка
 * строки, «Скачать Excel» и «Загрузить из Excel» в их формате (заменяет
 * справочник целиком). Пока идёт обработка, справочники не меняются.
 */
export function OnecRefsTab({
  refKind: ref,
  info,
  locked,
}: {
  refKind: OnecRefKind;
  info: OnecRefInfo | undefined;
  locked: boolean;
}) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data, isPending } = useQuery(onecRefQuery(ref));
  const rows = useMemo(() => (data ?? []) as Row[], [data]);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => {
    if (ref !== "nomenclature") return [];
    const set = new Set<string>(BASE_DESIGNATIONS);
    for (const r of rows) if (r.category) set.add(r.category);
    return [...set];
  }, [ref, rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        if (ref === "nomenclature" && category !== "all" && (row.category ?? "") !== category) {
          return false;
        }
        return !q || Object.values(row).some((v) => (v ?? "").toLowerCase().includes(q));
      });
  }, [rows, search, category, ref]);
  const table = usePagination(filtered, 50, `${ref}|${search}|${category}`);

  const refresh = () => qc.invalidateQueries({ queryKey: onecKey() });

  const replaceAll = async (next: Row[], source: "edit" | "import") => {
    await unwrap(
      supabase.rpc("an_onec_ref_replace", { p_ref: ref, p_rows: next, p_source: source }),
    );
    await refresh();
  };

  const importFile = async (file: File | undefined) => {
    if (input.current) input.current.value = "";
    if (!file) return;
    try {
      const parsed = await readOnecRefFile(ref, file);
      const ok = await confirm({
        title: `Заменить ${ONEC_REF_TITLES[ref].toLowerCase()}?`,
        description: `Строк в файле: ${formatNumber(parsed.length)}, сейчас: ${formatNumber(rows.length)}. Справочник заменится целиком.`,
        confirmLabel: "Заменить",
        destructive: false,
      });
      if (!ok) return;
      setBusy(true);
      await replaceAll(parsed as Row[], "import");
      toast.success("Справочник загружен");
    } catch (e) {
      toast.error(onecErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const exportFile = async () => {
    try {
      await downloadOnecRef(ref, rows as OnecRefRow[]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const columns = TABLE_COLUMNS[ref];
  return (
    <div className="space-y-3">
      <InfoNote>{INTRO[ref]}</InfoNote>
      <TableToolbar>
        <ToolbarSearch value={search} onChange={setSearch} placeholder="Поиск по справочнику" />
        {ref === "nomenclature" && (
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger aria-label="Обозначение" className="w-56">
              <SelectValue placeholder="Все обозначения" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все обозначения</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          {ref !== "nomenclature" && (
            <Button
              variant="outline"
              disabled={locked || busy}
              onClick={() => setEditing({ index: null })}
            >
              <Plus />
              Строка
            </Button>
          )}
          <Button variant="outline" disabled={!data} onClick={() => void exportFile()}>
            <Download />
            Скачать Excel
          </Button>
          <Button
            variant="outline"
            disabled={locked || busy}
            onClick={() => input.current?.click()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            Загрузить из Excel
          </Button>
          <input
            ref={input}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
        </div>
      </TableToolbar>
      <div className="text-xs text-muted-foreground">
        {ONEC_REF_FILES[ref]} · строк: {formatNumber(info?.rows ?? rows.length)}
        {info?.updated_at &&
          ` · изменён ${formatMsk(info.updated_at)}${info.source ? ` ${SOURCE_TEXT[info.source]}` : ""}${info.updated_by ? ` (${info.updated_by})` : ""}`}
        {locked && " · идёт обработка — справочник не меняется"}
      </div>
      <div className="overflow-hidden rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c}>{header(ref, c)}</TableHead>
              ))}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableSkeletonRows columns={columns.length + 1} rows={6} />
            ) : table.paged.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={columns.length + 1}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {rows.length === 0
                    ? "Справочник пуст — загрузите их файл из Excel."
                    : "Ничего не найдено."}
                </TableCell>
              </TableRow>
            ) : (
              table.paged.map(({ row, index }) => (
                <TableRow key={index}>
                  {columns.map((c) => (
                    <TableCell
                      key={c}
                      className={c === "code" ? "whitespace-nowrap font-mono text-xs" : "text-sm"}
                    >
                      {c === "names" ? (
                        <span className="line-clamp-2">{row[c]}</span>
                      ) : (
                        (row[c] ?? "")
                      )}
                    </TableCell>
                  ))}
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Изменить строку"
                      disabled={locked}
                      onClick={() => setEditing({ index })}
                    >
                      <Pencil />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <DataPagination {...table} loading={isPending} />

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-lg">
          {editing &&
            (ref === "nomenclature" && editing.index !== null ? (
              <NomenclatureForm
                key={editing.index}
                row={rows[editing.index] as NomenclatureRefRow}
                categories={categories}
                onClose={() => setEditing(null)}
                onSaved={refresh}
              />
            ) : (
              <RowForm
                key={editing.index ?? "new"}
                refKind={ref}
                row={editing.index === null ? null : rows[editing.index]}
                onClose={() => setEditing(null)}
                onSave={async (next) => {
                  const all = [...rows];
                  if (editing.index === null) all.push(next);
                  else all[editing.index] = next;
                  await replaceAll(all, "edit");
                }}
                onDelete={
                  editing.index === null
                    ? undefined
                    : async () => {
                        await replaceAll(
                          rows.filter((_, i) => i !== editing.index),
                          "edit",
                        );
                      }
                }
              />
            ))}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </div>
  );
}

/** Строка справочника студий или точки 0 — все колонки их файла. */
function RowForm({
  refKind: ref,
  row,
  onClose,
  onSave,
  onDelete,
}: {
  refKind: OnecRefKind;
  row: Row | null;
  onClose: () => void;
  onSave: (row: Row) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const columns = ONEC_REF_COLUMNS[ref];
  const [values, setValues] = useState<Row>(() =>
    Object.fromEntries(columns.map((c) => [c.key, row?.[c.key] ?? ""])),
  );
  const [saving, setSaving] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  const run = async (fn: () => Promise<void>, success: string) => {
    setSaving(true);
    try {
      await fn();
      toast.success(success);
      onClose();
    } catch (e) {
      toast.error(onecErrorText(e));
    } finally {
      setSaving(false);
    }
  };
  const save = () =>
    run(
      // Пустое поле — пустая ячейка, как в их файле.
      () =>
        onSave(
          Object.fromEntries(
            columns.map((c) => [c.key, values[c.key] === "" ? null : values[c.key]]),
          ),
        ),
      "Сохранено",
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{row ? "Строка справочника" : "Новая строка"}</DialogTitle>
        <DialogDescription>{ONEC_REF_TITLES[ref]}</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void save()}>
        <DialogBody>
          <div className="space-y-3">
            {columns.map((c) => (
              <FormField
                key={c.key}
                label={c.header}
                hint={
                  ref === "studios" && c.key === "status"
                    ? `«${OPEN}» или «${CLOSED}»: студия выручки без статуса останавливает обработку.`
                    : undefined
                }
              >
                {c.key.endsWith("comment") ? (
                  <Textarea
                    rows={2}
                    value={values[c.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
                  />
                ) : (
                  <Input
                    value={values[c.key] ?? ""}
                    inputMode={c.numeric ? "decimal" : undefined}
                    onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
                  />
                )}
              </FormField>
            ))}
          </div>
        </DialogBody>
        <DialogFooter>
          {onDelete && (
            <Button
              variant="outline"
              className="mr-auto text-destructive"
              disabled={saving}
              onClick={async () => {
                if (await confirm({ title: "Удалить строку справочника?" })) {
                  await run(onDelete, "Строка удалена");
                }
              }}
            >
              Удалить
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
      {confirmDialog}
    </>
  );
}

/** Номенклатура: меняются только «Обозначение» и «Направление» (как правка их файла). */
function NomenclatureForm({
  row,
  categories,
  onClose,
  onSaved,
}: {
  row: NomenclatureRefRow;
  categories: string[];
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [category, setCategory] = useState(row.category);
  const [direction, setDirection] = useState(row.direction);
  const [saving, setSaving] = useState(false);
  const options =
    categories.includes(row.category) || !row.category ? categories : [row.category, ...categories];

  const save = async () => {
    setSaving(true);
    try {
      await unwrap(
        supabase.rpc("an_onec_nomenclature_update", {
          p_changes: [{ code: row.code, category, direction }],
        }),
      );
      await onSaved();
      toast.success("Сохранено");
      onClose();
    } catch (e) {
      toast.error(onecErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="font-mono">{row.code}</DialogTitle>
        <DialogDescription>{ONEC_REF_TITLES.nomenclature}</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void save()}>
        <DialogBody>
          <div className="space-y-3">
            <div className="space-y-1 rounded-md bg-muted/40 p-3 text-sm">
              {row.names.split(" | ").map((n, i) => (
                <div key={i}>{n}</div>
              ))}
            </div>
            <FormField label="Обозначение номенклатуры" htmlFor={null}>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger aria-label="Обозначение номенклатуры">
                  <SelectValue placeholder="Не выбрано" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Направление номенклатуры" optional>
              <Input value={direction} onChange={(e) => setDirection(e.target.value)} />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

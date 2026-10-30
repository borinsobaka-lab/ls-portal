import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchInput } from "@/components/ui/search-input";
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
import { supabase } from "@/integrations/supabase/client";
import { onecErrorText, type OnecRun } from "@/lib/analytics/onec-page";
import { UNDEFINED } from "@/lib/analytics/onec/rules";
import { unwrap } from "@/lib/query";

/**
 * Окно «Новые номенклатуры» — их NomenclatureReviewDialog: категория для
 * каждой новой позиции (несколько строк сразу), подсказка по ключевым
 * словам, поиск, «Показывать классифицированные». «Сохранить и продолжить» —
 * только когда выбраны все: категории — в справочник, обработка — дальше.
 */
export function OnecReviewDialog({
  run,
  open,
  onOpenChange,
  onSubmitted,
}: {
  run: OnecRun;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        {run.review && (
          <ReviewForm
            key={run.id}
            run={run}
            items={run.review.items}
            choices={run.review.choices.filter((c) => c !== UNDEFINED)}
            onClose={() => onOpenChange(false)}
            onSubmitted={onSubmitted}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewForm({
  run,
  items,
  choices,
  onClose,
  onSubmitted,
}: {
  run: OnecRun;
  items: NonNullable<OnecRun["review"]>["items"];
  choices: string[];
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(items.slice(0, 1).map((i) => i.code)),
  );
  const [search, setSearch] = useState("");
  const [showAssigned, setShowAssigned] = useState(false);
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (!showAssigned && item.code in assignments) return false;
      return !q || `${item.code} ${item.name} ${item.reason}`.toLowerCase().includes(q);
    });
  }, [items, assignments, search, showAssigned]);

  const assigned = Object.keys(assignments).length;
  const hint = (item: (typeof items)[number]) =>
    assignments[item.code] ??
    (item.suggested_designation !== UNDEFINED
      ? `Подсказка: ${item.suggested_designation}`
      : "Выберите категорию");

  const select = (codes: string[], on: boolean) => {
    const next = new Set(selected);
    for (const c of codes) {
      if (on) next.add(c);
      else next.delete(c);
    }
    setSelected(next);
    // Категория у всех выбранных одна — показать её (как у них on_select).
    const cats = new Set([...next].map((c) => assignments[c] ?? ""));
    setCategory(cats.size === 1 ? [...cats][0] : "");
  };

  const chosen = [...selected].filter((c) => visible.some((i) => i.code === c));
  const apply = () => {
    if (!chosen.length || !category) {
      toast.warning("Выберите одну или несколько строк и категорию.");
      return;
    }
    setAssignments((a) => ({ ...a, ...Object.fromEntries(chosen.map((c) => [c, category])) }));
  };
  const clear = () => {
    if (!chosen.length) {
      toast.warning("Выберите одну или несколько строк.");
      return;
    }
    setAssignments((a) =>
      Object.fromEntries(Object.entries(a).filter(([c]) => !chosen.includes(c))),
    );
  };

  const save = async () => {
    setSaving(true);
    try {
      await unwrap(
        supabase.rpc("an_onec_review_submit", { p_run: run.id, p_assignments: assignments }),
      );
      toast.success("Категории сохранены в справочник. Продолжаем обработку.");
      onSubmitted();
      onClose();
    } catch (e) {
      toast.error(onecErrorText(e));
    } finally {
      setSaving(false);
    }
  };

  const allVisibleSelected = visible.length > 0 && visible.every((i) => selected.has(i.code));

  return (
    <>
      <DialogHeader>
        <DialogTitle>В новых выгрузках найдены номенклатуры: {items.length}</DialogTitle>
        <DialogDescription>
          Выберите категорию для каждой позиции. Выбор сразу сохранится в справочник и будет
          использоваться при следующих запусках.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Поиск"
              wrapperClassName="w-full sm:w-64"
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={showAssigned}
                onCheckedChange={(v) => setShowAssigned(v === true)}
              />
              Показывать классифицированные
            </label>
          </div>
          <div className="max-h-[45vh] overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Выбрать все"
                      checked={allVisibleSelected}
                      onCheckedChange={(v) =>
                        select(
                          visible.map((i) => i.code),
                          v === true,
                        )
                      }
                    />
                  </TableHead>
                  <TableHead>Код</TableHead>
                  <TableHead>Название</TableHead>
                  <TableHead>Причина проверки</TableHead>
                  <TableHead>Выбранная категория</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="py-6 text-center text-sm text-muted-foreground"
                    >
                      {assigned === items.length
                        ? "Все позиции классифицированы."
                        : "Ничего не найдено."}
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((item) => (
                    <TableRow
                      key={item.code}
                      data-state={selected.has(item.code) ? "selected" : undefined}
                      className="cursor-pointer"
                      onClick={() => select([item.code], !selected.has(item.code))}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          aria-label={`Выбрать ${item.code}`}
                          checked={selected.has(item.code)}
                          onCheckedChange={(v) => select([item.code], v === true)}
                        />
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {item.code}
                      </TableCell>
                      <TableCell className="text-sm">{item.name}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm">{item.reason}</TableCell>
                      <TableCell
                        className={
                          item.code in assignments
                            ? "text-sm font-medium"
                            : "text-sm text-muted-foreground"
                        }
                      >
                        {hint(item)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger aria-label="Категория" className="w-full sm:w-72">
                <SelectValue placeholder="Категория" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={clear}>
              Снять категорию
            </Button>
            <Button variant="outline" onClick={apply}>
              Применить к выбранным строкам
            </Button>
          </div>
        </div>
      </DialogBody>
      <DialogFooter className="sm:justify-between">
        <span className="self-center text-sm text-muted-foreground">
          Классифицировано: {assigned} из {items.length}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Закрыть
          </Button>
          <Button onClick={() => void save()} disabled={saving || assigned !== items.length}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить и продолжить
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

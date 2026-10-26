import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2 } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { ImageUploadField, StorageImage } from "@/components/image-upload-field";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useActiveStudio, useStudios, type Studio } from "@/hooks/use-studios";
import { useCatalogStudioIds } from "@/hooks/use-catalog-studios";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ColorInput } from "@/components/ui/color-input";
import { FormField } from "@/components/ui/form-field";
import { FormattedTextarea } from "@/components/formatted-textarea";
import { ContentLangLabel, ContentLangNote, ContentLangSwitch } from "@/components/content-lang";
import { useContentTranslations } from "@/hooks/use-content-translations";
import type { ContentTranslations } from "@/lib/content-i18n";
import { stripFormatting } from "@/lib/formatted-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogForm,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DAY_TYPES,
  DAY_TYPE_COLORS,
  WORKOUT_COLORS,
  type DayType,
  dayTypeColor,
  dayTypeLabel,
  isWorkoutColor,
} from "@/lib/workout-types";
import { TableSkeletonRows } from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { WorkoutsPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  description:
    "Клиенты видят его в карточке занятия в расписании приложения. Можно выделять жирным, делать списки и ссылки.",
  type: "Задаёт цвет метки и MET по умолчанию, если поле MET пустое.",
  capacity:
    "Сколько человек вмещает зал клуба на этой тренировке — своя цифра в каждом клубе. Её подставит «Расписание» новому занятию (там её можно поменять на один день). Когда места заняты, новые записи встают в лист ожидания.",
  color:
    "Полоска этого цвета слева на карточке занятия в расписании — видно, какие тренировки когда стоят.",
  met: "Интенсивность: по ней клиенту оцениваются сожжённые калории (ккал ≈ MET × 3.5 × вес / 200 × мин).",
};

export const Route = createFileRoute("/_authenticated/workouts")({
  head: () => ({ meta: [{ title: "Тренировки — Base40 Admin" }] }),
  pendingComponent: WorkoutsPageSkeleton,
  component: WorkoutsPage,
});

type Workout = {
  id: string;
  studio_id: string;
  name: string;
  description: string | null;
  photo_url: string | null;
  /** По умолчанию — для клуба без своей строки в capacities. */
  capacity: number | null;
  /** Вместимость в каждом клубе (workout_capacities): null — без лимита. */
  capacities: WorkoutCapacity[];
  type: DayType | null;
  met_value: number | null;
  /** Пакетный формат: цвет полоски в расписании (#rrggbb). */
  color: string | null;
  /** Переводы для приложения: {en|ka: {name, description}}. */
  translations: ContentTranslations;
};

type WorkoutCapacity = { studio_id: string; capacity: number | null };

/** Вместимость тренировки в клубе: своя строка, иначе по умолчанию. */
function capacityIn(w: Pick<Workout, "capacity" | "capacities">, studioId: string) {
  const own = w.capacities?.find((c) => c.studio_id === studioId);
  return own ? own.capacity : w.capacity;
}

const NONE_TYPE = "__none__" as const;

function WorkoutTypeBadge({ value }: { value: DayType | null }) {
  const color = dayTypeColor(value);
  if (!color) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${color.dot}`} />
      {dayTypeLabel(value)}
    </span>
  );
}

function ColorSwatch({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className="inline-block h-4 w-8 rounded-sm border border-black/10"
      style={{ backgroundColor: value }}
      title={value}
    />
  );
}

/** Вместимость в таблице: одна цифра или по клубам, если их несколько. */
function CapacityCell({ workout, studios }: { workout: Workout; studios: Studio[] }) {
  if (studios.length <= 1) {
    const c = studios[0] ? capacityIn(workout, studios[0].id) : workout.capacity;
    return <span className="tabular-nums">{c || "—"}</span>;
  }
  return (
    <div className="space-y-0.5">
      {studios.map((st) => (
        <div key={st.id} className="whitespace-nowrap">
          {st.name}: <span className="tabular-nums">{capacityIn(workout, st.id) || "—"}</span>
        </div>
      ))}
    </div>
  );
}

function WorkoutsPage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  // В пакетных студиях у тренировки нет типа и иконки, зато есть цвет, а
  // MET ставится вручную всегда (STUDIO_FORMATS.md, 2026-10-11).
  const packages = useActiveStudio()?.format === "packages";
  // У пакетных клубов список общий на все пакетные клубы (lib/studio-catalog.ts).
  const catalogIds = useCatalogStudioIds();
  // Вместимость — по клубам каталога, где сотрудник работает (решение
  // владельца 2026-10-14): столько полей, сколько у него таких клубов.
  const { data: myStudios = [] } = useStudios();
  const capacityStudios = catalogIds ? myStudios.filter((st) => catalogIds.includes(st.id)) : [];
  const columns = packages ? 5 : 6;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Workout | null>(null);
  const [search, setSearch] = useState("");

  const { data: workouts = [], isLoading: loading } = useQuery({
    queryKey: ["workouts", studioId, catalogIds?.join(",")],
    queryFn: () =>
      unwrap<Workout[]>(
        supabase
          .from("workouts")
          .select("*, capacities:workout_capacities(studio_id, capacity)")
          .in("studio_id", catalogIds!)
          .order("created_at", { ascending: false }),
      ),
    enabled: !!studioId && !!catalogIds,
    meta: { errorMessage: "Не удалось загрузить тренировки" },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["workouts"] });

  const q = search.trim().toLowerCase();
  const filteredWorkouts = q
    ? workouts.filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          (w.description ?? "").toLowerCase().includes(q) ||
          dayTypeLabel(w.type).toLowerCase().includes(q),
      )
    : workouts;

  // Вместимость — своя в каждом клубе: сортируем по активному.
  const sort = useTableSort<Workout>({
    color: (w) => w.color,
    name: (w) => w.name,
    type: (w) => (w.type ? dayTypeLabel(w.type) : null),
    description: (w) => (w.description ? stripFormatting(w.description) : null),
    capacity: (w) => (studioId ? capacityIn(w, studioId) : w.capacity),
    met: (w) => (w.met_value != null ? Number(w.met_value) : null),
  });
  const pg = usePagination(sort.apply(filteredWorkouts), undefined, sort.key);

  const handleDelete = async (w: Workout) => {
    if (
      !(await confirm({
        title: "Удалить тренировку?",
        description: packages
          ? `«${w.name}» будет удалена во всех клубах с пакетами тренировок. Занятия в расписании этих клубов, использующие её, тоже пропадут.`
          : `«${w.name}» будет удалена. Занятия в расписании, использующие её, тоже пропадут.`,
      }))
    )
      return;
    const { error } = await supabase.from("workouts").delete().eq("id", w.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success("Тренировка удалена");
    reload();
  };

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };

  const openEdit = (w: Workout) => {
    setEditing(w);
    setOpen(true);
  };

  return (
    <AdminShell
      title="Тренировки"
      actions={
        <Button onClick={openCreate} disabled={!studioId}>
          <Plus />
          Добавить тренировку
        </Button>
      }
    >
      <div className="space-y-3">
        <RequireStudio studioId={studioId}>
          <TableToolbar>
            <ToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Поиск по названию или описанию"
            />
          </TableToolbar>
          <div className="rounded-lg border bg-background">
            <Table>
              <TableHeader>
                <TableRow>
                  {packages ? (
                    <TableHead className="w-[80px]" tip={TIPS.color} {...sort.head("color")}>
                      Цвет
                    </TableHead>
                  ) : (
                    <TableHead className="w-[100px]">Иконка</TableHead>
                  )}
                  <TableHead {...sort.head("name")}>Название</TableHead>
                  {!packages && (
                    <TableHead className="w-[160px]" tip={TIPS.type} {...sort.head("type")}>
                      Тип
                    </TableHead>
                  )}
                  <TableHead tip={TIPS.description} {...sort.head("description")}>
                    Описание
                  </TableHead>
                  <TableHead className="w-[160px]" tip={TIPS.capacity} {...sort.head("capacity")}>
                    Вместимость
                  </TableHead>
                  <TableHead
                    className="w-[90px]"
                    tip={packages ? TIPS.met : undefined}
                    {...sort.head("met")}
                  >
                    MET
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={columns} />
                ) : filteredWorkouts.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={columns}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {workouts.length === 0
                        ? "Пока нет тренировок. Нажмите «Добавить тренировку»."
                        : "Ничего не найдено по выбранным фильтрам."}
                    </TableCell>
                  </TableRow>
                ) : (
                  pg.paged.map((w) => (
                    <RowContextMenu
                      key={w.id}
                      actions={[
                        { label: "Редактировать", icon: Pencil, onSelect: () => openEdit(w) },
                        {
                          label: "Удалить",
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => handleDelete(w),
                        },
                      ]}
                    >
                      <TableRow>
                        <TableCell>
                          {packages ? (
                            <ColorSwatch value={w.color} />
                          ) : (
                            <StorageImage bucket="workouts" value={w.photo_url} alt={w.name} />
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{w.name}</TableCell>
                        {!packages && (
                          <TableCell>
                            <WorkoutTypeBadge value={w.type} />
                          </TableCell>
                        )}
                        <TableCell className="max-w-[420px] truncate text-muted-foreground">
                          {w.description ? stripFormatting(w.description) : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          <CapacityCell workout={w} studios={capacityStudios} />
                        </TableCell>
                        <TableCell className="text-sm tabular-nums text-muted-foreground">
                          {w.met_value != null ? Number(w.met_value).toFixed(1) : "—"}
                        </TableCell>
                      </TableRow>
                    </RowContextMenu>
                  ))
                )}
              </TableBody>
            </Table>
            <DataPagination {...pg} loading={loading} />
          </div>
        </RequireStudio>
      </div>

      <WorkoutDialog
        open={open}
        onOpenChange={setOpen}
        studioId={studioId}
        workout={editing}
        packages={packages}
        capacityStudios={capacityStudios}
        usedColors={workouts.map((w) => w.color)}
        onSaved={reload}
      />
      {confirmDialog}
    </AdminShell>
  );
}

type DialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  studioId: string | null;
  workout: Workout | null;
  /** Пакетная студия: цвет вместо типа и иконки, MET обязателен. */
  packages: boolean;
  /** Клубы каталога, где работает сотрудник, — поле вместимости на каждый. */
  capacityStudios: Studio[];
  /** Цвета других тренировок — новой предлагается ещё не занятый. */
  usedColors: (string | null)[];
  onSaved: () => void;
};

function WorkoutDialog(props: DialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <WorkoutForm key={props.workout?.id ?? "new"} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function WorkoutForm({
  onOpenChange,
  studioId,
  workout,
  packages,
  capacityStudios,
  usedColors,
  onSaved,
}: DialogProps) {
  const [name, setName] = useState(workout?.name ?? "");
  const [description, setDescription] = useState(workout?.description ?? "");
  const [photoUrl, setPhotoUrl] = useState(workout?.photo_url ?? null);
  // Клуб → вместимость строкой («» — без лимита).
  const [capacities, setCapacities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      capacityStudios.map((st) => {
        const c = workout ? capacityIn(workout, st.id) : null;
        return [st.id, c != null ? String(c) : ""];
      }),
    ),
  );
  const [metValue, setMetValue] = useState(
    workout?.met_value != null ? String(workout.met_value) : "",
  );
  const [type, setType] = useState<DayType | typeof NONE_TYPE>(workout?.type ?? NONE_TYPE);
  const [color, setColor] = useState(
    () =>
      workout?.color ??
      [...WORKOUT_COLORS.filter((c) => c.basic), ...WORKOUT_COLORS.filter((c) => !c.basic)].find(
        (c) => !usedColors.includes(c.hex),
      )?.hex ??
      WORKOUT_COLORS[0].hex,
  );
  const tr = useContentTranslations(workout?.translations);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!studioId) return;
    if (!name.trim()) {
      tr.setLang("ru");
      toast.error("Укажите название");
      return;
    }
    const capacityRows: WorkoutCapacity[] = capacityStudios.map((st) => {
      const raw = (capacities[st.id] ?? "").trim();
      return { studio_id: st.id, capacity: raw === "" ? null : Number(raw) };
    });
    if (
      capacityRows.some(
        (r) => r.capacity != null && (!Number.isInteger(r.capacity) || r.capacity < 0),
      )
    ) {
      toast.error("Вместимость должна быть целым неотрицательным числом");
      return;
    }
    // По умолчанию (клуб без своей строки, старый код) — вместимость активного
    // клуба, иначе первого из полей.
    const defaultCapacity = (capacityRows.find((r) => r.studio_id === studioId) ?? capacityRows[0])
      ?.capacity;
    const metNum = metValue.trim() === "" ? null : Number(metValue);
    if (packages && metNum == null) {
      toast.error("Укажите интенсивность (MET)");
      return;
    }
    if (metNum != null && (!Number.isFinite(metNum) || metNum <= 0)) {
      toast.error("MET должен быть положительным числом");
      return;
    }
    if (packages && !isWorkoutColor(color)) {
      toast.error("Цвет — в формате #RRGGBB");
      return;
    }

    setSaving(true);
    try {
      const common = {
        name: name.trim(),
        description: description.trim() || null,
        translations: tr.cleaned(),
        ...(defaultCapacity !== undefined ? { capacity: defaultCapacity } : {}),
        met_value: metNum,
      };
      // Пакетной тренировке тип и иконку не пишем вовсе: у неё их нет.
      // Подписочной — не пишем цвет: её цвет по-прежнему от типа.
      const payload: Record<string, unknown> = packages
        ? { ...common, type: null, color: color.toLowerCase() }
        : { ...common, photo_url: photoUrl, type: type === NONE_TYPE ? null : type };
      const { data: saved, error } = workout
        ? await supabase.from("workouts").update(payload).eq("id", workout.id).select("id").single()
        : // Новая — в активном клубе; у пакетных она сразу видна во всех пакетных
          // клубах. Правка клуб строки не меняет.
          await supabase
            .from("workouts")
            .insert({ ...payload, studio_id: studioId })
            .select("id")
            .single();
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      if (capacityRows.length > 0) {
        const { error: capError } = await supabase.from("workout_capacities").upsert(
          capacityRows.map((r) => ({
            ...r,
            workout_id: saved.id as string,
            updated_at: new Date().toISOString(),
          })),
        );
        if (capError) {
          toast.error("Тренировка сохранена, но вместимость — нет: " + capError.message);
          onOpenChange(false);
          onSaved();
          return;
        }
      }
      toast.success(workout ? "Тренировка обновлена" : "Тренировка добавлена");
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{workout ? "Редактировать тренировку" : "Новая тренировка"}</DialogTitle>
        <DialogDescription>
          {packages
            ? "Тренировка общая для всех клубов с пакетами тренировок: изменения сразу видны во всех клубах."
            : "Заполните данные тренировки клуба."}
        </DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            {!packages && (
              <FormField label="Иконка" htmlFor={null} optional>
                <ImageUploadField
                  bucket="workouts"
                  folder={`${studioId}`}
                  value={photoUrl}
                  onChange={setPhotoUrl}
                  preview={
                    <StorageImage
                      bucket="workouts"
                      value={photoUrl}
                      alt="Иконка"
                      className="size-16"
                    />
                  }
                  disabled={!studioId}
                />
              </FormField>
            )}

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Название</ContentLangLabel>}
              required={tr.lang === "ru"}
            >
              <Input {...tr.input("name", name, setName, "Например: Силовая базовая")} />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Описание</ContentLangLabel>}
              tip={TIPS.description}
              optional
            >
              <FormattedTextarea
                rows={4}
                {...tr.text(
                  "description",
                  description,
                  setDescription,
                  "Краткое описание тренировки",
                )}
              />
            </FormField>

            {packages ? (
              <FormField label="Цвет" htmlFor={null} tip={TIPS.color} required>
                <ColorInput
                  value={color}
                  onChange={setColor}
                  fallback={WORKOUT_COLORS[0].hex}
                  swatches={WORKOUT_COLORS}
                />
              </FormField>
            ) : (
              <FormField label="Тип тренировки" tip={TIPS.type} optional>
                <Select
                  value={type}
                  onValueChange={(v) => setType(v as DayType | typeof NONE_TYPE)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Выберите тип" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_TYPE}>
                      <span className="text-muted-foreground">Не указан</span>
                    </SelectItem>
                    {DAY_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            className={`inline-block h-2.5 w-2.5 rounded-full ${DAY_TYPE_COLORS[t.value].dot}`}
                          />
                          {t.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}

            {capacityStudios.length > 0 && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {capacityStudios.map((st) => (
                  <FormField
                    key={st.id}
                    label={
                      capacityStudios.length > 1
                        ? `Вместимость — ${st.name}, чел.`
                        : "Вместимость, чел."
                    }
                    tip={TIPS.capacity}
                    optional
                  >
                    <Input
                      type="number"
                      min={0}
                      value={capacities[st.id] ?? ""}
                      onChange={(e) =>
                        setCapacities((prev) => ({ ...prev, [st.id]: e.target.value }))
                      }
                      placeholder="Без лимита"
                    />
                  </FormField>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                label="MET — интенсивность"
                optional={!packages}
                required={packages}
                tip={packages ? TIPS.met : undefined}
                hint={
                  packages
                    ? "Например: растяжка 2.5, пилатес 3.0, силовая 6.0, кардио 8.0."
                    : "Для оценки калорий: ккал ≈ MET × 3.5 × вес / 200 × мин. Если пусто — значение по умолчанию для типа: кардио 8.5, силовая 7.0, гибрид 8.0, восстановление 2.8."
                }
              >
                <Input
                  type="number"
                  step="0.1"
                  min={0}
                  value={metValue}
                  onChange={(e) => setMetValue(e.target.value)}
                  placeholder="Например: 8.0"
                />
              </FormField>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
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

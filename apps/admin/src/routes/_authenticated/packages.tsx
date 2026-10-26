import { createFileRoute } from "@tanstack/react-router";
import { useState, type DragEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2, Copy, GripVertical } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { RequireFormat } from "@/components/require-format";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { useCatalogStudioIds } from "@/hooks/use-catalog-studios";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { formatMoney } from "@/lib/format";
import {
  MEMBERSHIP_KIND_LABEL,
  MEMBERSHIP_KINDS,
  SINGLE_VISIT,
  type MembershipKind,
} from "@/lib/payments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormattedTextarea } from "@/components/formatted-textarea";
import { stripFormatting } from "@/lib/formatted-text";
import { BenefitsEditor } from "@/components/benefits-editor";
import { ContentLangLabel, ContentLangNote, ContentLangSwitch } from "@/components/content-lang";
import { useContentTranslations } from "@/hooks/use-content-translations";
import { TRANSLATED_LANGS, translationText, type ContentTranslations } from "@/lib/content-i18n";
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { StatusChip } from "@/components/ui/status-chip";
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
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { TableSkeletonRows } from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { PackagesPageSkeleton } from "@/components/page-skeletons";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  kind: "Пакет тренировок расходуется на групповых занятиях, пакет персональных — на персональных с тренером. Разовое посещение — одна групповая тренировка на месяц, продаёт администратор, в приложении его нет. Пробное посещение продаётся типом «Оплата пробного» в «Абонементах».",
  single:
    "У разового посещения условия постоянные: 1 групповая тренировка, срок 1 месяц (30 дней), оплата одним платежом. Меняется только стоимость.",
  visits:
    "Сколько тренировок входит в пакет. С баланса списывается одна, когда администратор отмечает посещение группового занятия.",
  trainings:
    "Групповых тренировок в номенклатуре и через «+» — персональных (у пакета тренировок — в подарок). «перс.» — персональные с тренером, у них отдельный баланс.",
  giftPersonal:
    "Сколько персональных тренировок входит в пакет в подарок. Это отдельный баланс: списывается, когда отмечено посещение персонального занятия. 0 — нет.",
  personal:
    "Сколько персональных тренировок в пакете. С баланса списывается одна, когда администратор отмечает посещение персонального занятия.",
  diagnostics:
    "Сколько диагностик тела входит в абонемент. Это отдельный баланс: списывается, когда отмечено посещение диагностики в расписании. В «В подарок» не показывается — для клиента напишите в «Что входит». 0 — нет.",
  duration: "Считается от даты продажи.",
  price:
    "Полная цена. Подставляется в продажу, скидку (например, постоянному клиенту) дают там, снижая стоимость. На уже проданные пакеты не влияет.",
  description:
    "Короткий текст под названием пакета в приложении, до цены. Можно выделять жирным, делать списки и ссылки.",
  order:
    "Перетащите строку за ручку, чтобы поменять порядок: в таком же порядке абонементы стоят в приложении. При поиске и сортировке по колонке перетаскивание выключено.",
  payments:
    "Сколькими ежемесячными платежами можно оплатить пакет (внутренняя рассрочка). 1 — только сразу. При продаже можно выбрать меньше.",
  tag: "Короткая пометка справа от названия в приложении: «Популярно», «Максимум», «Старт». Пусто — без тега. Яркий — розовая плашка с белым текстом, бледный — светлая.",
  benefits:
    "Пункты «Что входит» в карточке пакета в приложении, по одному: «2 диагностики тела», «Продление со скидкой 35%». Пусто — приложение напишет число тренировок и рассрочку само.",
  gift: "Блок «В подарок» под составом пакета в приложении (заголовок всегда «В подарок»). Например: **Персональная тренировка** — 110 ₾. Персональные в подарок отдельной строкой в составе не показываются — напишите их здесь.",
};

type TagStyle = "soft" | "bright";

const TAG_STYLES: { value: TagStyle; label: string }[] = [
  { value: "soft", label: "Бледный" },
  { value: "bright", label: "Яркий" },
];

/**
 * Тег номенклатуры — как в приложении: бледный или яркий. Цвет — основной
 * цвет пакетного приложения (#F763FC, apps/client), а не бренд клуба.
 */
function PackageTag({ text, style }: { text: string; style: TagStyle | null }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium ${
        style === "bright" ? "bg-[#F763FC] text-white" : "bg-[#F763FC]/15 text-[#B41FBA]"
      }`}
    >
      {text}
    </span>
  );
}

/** Предел платежей — как ограничение memberships.max_payments в БД. */
const MAX_PAYMENTS_LIMIT = 12;

/**
 * Номенклатура «Зала с пакетами тренировок» (STUDIO_FORMATS.md): пакеты —
 * строки той же таблицы memberships, что и подписки, но без автопродления,
 * заморозки и безлимита. Рассрочка своя — «сколькими платежами можно
 * оплатить» (max_payments), подписочная installment_enabled не используется. В номенклатуре — только полная цена:
 * скидку (например, постоянному клиенту) дают при продаже, снижая стоимость
 * (решение владельца 2026-10-11). Подписочная номенклатура — memberships.tsx.
 */
export const Route = createFileRoute("/_authenticated/packages")({
  head: () => ({ meta: [{ title: "Номенклатуры — Lady Stretch" }] }),
  pendingComponent: PackagesPageSkeleton,
  component: PackagesRoute,
});

type Package = {
  id: string;
  studio_id: string;
  name: string;
  description: string | null;
  visits_count: number | null;
  duration_days: number | null;
  price: number;
  /** Сколькими платежами можно оплатить (1 — только сразу). */
  max_payments: number;
  /** Пакет тренировок, пакет персональных или пробное посещение. */
  kind: MembershipKind;
  /** Персональных: у пакета тренировок — подарочные, у пакета персональных — количество. */
  personal_count: number;
  /** Диагностик тела в абонементе (0 — нет), отдельный баланс. */
  diagnostics_count: number;
  is_active: boolean;
  /** Порядок в таблице и в приложении (по возрастанию, перетаскивание строк). */
  sort_order: number;
  /** Тег справа от названия в приложении и его вид. */
  tag_text: string | null;
  tag_style: TagStyle | null;
  /** Блок «В подарок» в приложении (текст с разметкой). */
  gift_text: string | null;
  /** «Что входит» в приложении — пункты по одному. */
  benefits: string[] | null;
  /** Переводы для приложения: {en|ka: {name, description, tag_text, gift_text, benefits[]}}. */
  translations: ContentTranslations;
};

/** Поля, которыми можно предзаполнить новый пакет (дублирование). */
type PackageDraft = Omit<Package, "id" | "studio_id" | "sort_order">;

const COLUMNS =
  "id, studio_id, name, description, visits_count, duration_days, price, max_payments, kind, personal_count, diagnostics_count, is_active, sort_order, tag_text, tag_style, gift_text, benefits, translations";

/** «Тренировок» в таблице: обычные и персональные по типу номенклатуры. */
function trainingsLabel(p: Package) {
  const diagnostics = p.diagnostics_count > 0 ? ` + ${p.diagnostics_count} диагн.` : "";
  if (p.kind === "personal") return `${p.personal_count} перс.${diagnostics}`;
  const visits = p.visits_count ?? "—";
  return (
    (p.personal_count > 0 ? `${visits} + ${p.personal_count} перс.` : String(visits)) + diagnostics
  );
}

/** Сортировка колонок (lib/table-sort.ts); «Тренировок» — основное число пакета. */
const SORT_GETTERS: SortGetters<Package> = {
  name: (p) => p.name,
  kind: (p) => MEMBERSHIP_KIND_LABEL[p.kind],
  trainings: (p) => (p.kind === "personal" ? p.personal_count : p.visits_count),
  duration: (p) => p.duration_days || null,
  price: (p) => Number(p.price),
  payments: (p) => p.max_payments,
  description: (p) => (p.description ? stripFormatting(p.description) : null),
  status: (p) => (p.kind === "single" ? null : p.is_active),
};

function formatDuration(days: number | null) {
  if (!days) return "—";
  if (days % 365 === 0) return `${days / 365} г.`;
  if (days % 30 === 0) return `${days / 30} мес.`;
  return `${days} дн.`;
}

function PackagesRoute() {
  return (
    <RequireFormat format="packages" title="Номенклатуры" other={{ subscription: "/memberships" }}>
      <PackagesPage />
    </RequireFormat>
  );
}

function PackagesPage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  // Номенклатура общая для всех пакетных клубов (lib/studio-catalog.ts):
  // при смене клуба в шапке список тот же.
  const catalogIds = useCatalogStudioIds();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Package | null>(null);
  const [draft, setDraft] = useState<PackageDraft | null>(null);
  // Перетаскивание строк: какая строка тянется и над какой сейчас.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const queryKey = ["memberships", studioId, "packages", catalogIds?.join(",")];

  const { data: items = [], isLoading: loading } = useQuery({
    queryKey,
    queryFn: () =>
      unwrap<Package[]>(
        supabase
          .from("memberships")
          .select(COLUMNS)
          .in("studio_id", catalogIds!)
          .order("sort_order")
          .order("name"),
      ),
    enabled: !!studioId && !!catalogIds,
    meta: { errorMessage: "Не удалось загрузить номенклатуры" },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["memberships"] });

  const handleDelete = async (p: Package) => {
    if (
      !(await confirm({
        title: "Удалить номенклатуру?",
        description: `«${p.name}» пропадёт из каталога всех клубов с пакетами тренировок. Если её уже продавали, удалить не получится — тогда скройте её переключателем в колонке «Статус».`,
      }))
    )
      return;
    const { error } = await supabase.from("memberships").delete().eq("id", p.id);
    if (error) {
      // 23503 — на номенклатуру ссылаются продажи и абонементы клиентов
      // (внешний ключ on delete restrict): удалять проданное нельзя.
      toast.error(
        error.code === "23503"
          ? "Эту номенклатуру уже продавали — удалить нельзя, пропала бы история продаж. Скройте её переключателем в колонке «Статус»."
          : "Ошибка удаления: " + error.message,
      );
      return;
    }
    toast.success("Номенклатура удалена");
    reload();
  };

  const handleToggleActive = async (p: Package, next: boolean) => {
    const { error } = await supabase.from("memberships").update({ is_active: next }).eq("id", p.id);
    if (error) {
      toast.error("Не удалось изменить статус: " + error.message);
      return;
    }
    toast.success(next ? "Показывается в приложении" : "Скрыто в приложении");
    reload();
  };

  /**
   * Строку dragged поставить на место target. Порядок пишется в
   * memberships.sort_order заново 1…N (только изменившимся строкам), сразу
   * показывается локально; при ошибке — перезагрузка с сервера.
   */
  const moveRow = async (draggedId: string, targetId: string) => {
    if (draggedId === targetId) return;
    const from = items.findIndex((p) => p.id === draggedId);
    const to = items.findIndex((p) => p.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const reordered = next.map((p, i) => ({ ...p, sort_order: i + 1 }));
    const changed = reordered.filter(
      (p) => items.find((o) => o.id === p.id)?.sort_order !== p.sort_order,
    );
    queryClient.setQueryData<Package[]>(queryKey, reordered);
    const results = await Promise.all(
      changed.map((p) =>
        supabase.from("memberships").update({ sort_order: p.sort_order }).eq("id", p.id),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      toast.error("Не удалось сохранить порядок: " + failed.error.message);
      reload();
    }
  };

  const dragProps = (p: Package) =>
    canDrag
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", p.id);
            setDragId(p.id);
          },
          onDragOver: (e: DragEvent) => {
            if (!dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (overId !== p.id) setOverId(p.id);
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (dragId) moveRow(dragId, p.id);
            setDragId(null);
            setOverId(null);
          },
          onDragEnd: () => {
            setDragId(null);
            setOverId(null);
          },
        }
      : {};

  const openCreate = (initial: PackageDraft | null = null) => {
    setEditing(null);
    setDraft(initial);
    setOpen(true);
  };
  const openEdit = (p: Package) => {
    setEditing(p);
    setDraft(null);
    setOpen(true);
  };

  const q = search.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
      )
    : items;
  const sort = useTableSort(SORT_GETTERS);
  const rows = sort.apply(filtered);
  // Порядок меняется только по полному списку в его порядке: при поиске и
  // сортировке по колонке строки не тянутся — место строки на экране не её
  // место в приложении.
  const canDrag = !q && !sort.sort && items.length > 1;

  return (
    <AdminShell
      title="Номенклатуры"
      actions={
        <Button onClick={() => openCreate()} disabled={!studioId}>
          <Plus />
          Добавить
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
                  <TableHead className="w-10" tip={TIPS.order}>
                    <span className="sr-only">Порядок</span>
                  </TableHead>
                  <TableHead {...sort.head("name")}>Название</TableHead>
                  <TableHead tip={TIPS.kind} {...sort.head("kind")}>
                    Тип
                  </TableHead>
                  <TableHead tip={TIPS.trainings} {...sort.head("trainings")}>
                    Тренировок
                  </TableHead>
                  <TableHead tip={TIPS.duration} {...sort.head("duration")}>
                    Срок действия
                  </TableHead>
                  <TableHead className="text-right" tip={TIPS.price} {...sort.head("price")}>
                    Стоимость
                  </TableHead>
                  <TableHead tip={TIPS.payments} {...sort.head("payments")}>
                    Платежей
                  </TableHead>
                  <TableHead tip={TIPS.description} {...sort.head("description")}>
                    Описание
                  </TableHead>
                  <TableHead {...sort.head("status")}>Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={9} />
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={9}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {items.length === 0
                        ? "Пока нет номенклатур. Нажмите «Добавить»."
                        : "Ничего не найдено."}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((p) => (
                    <RowContextMenu
                      key={p.id}
                      actions={[
                        {
                          label: "Дублировать",
                          icon: Copy,
                          onSelect: () =>
                            openCreate({ ...p, name: `${p.name} (копия)`, is_active: true }),
                        },
                        { label: "Редактировать", icon: Pencil, onSelect: () => openEdit(p) },
                        {
                          label: "Удалить",
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => handleDelete(p),
                        },
                      ]}
                    >
                      <TableRow
                        {...dragProps(p)}
                        className={[
                          p.is_active ? "" : "opacity-60",
                          dragId === p.id ? "opacity-40" : "",
                          overId === p.id && dragId !== p.id
                            ? "outline-2 -outline-offset-2 outline-ring"
                            : "",
                        ].join(" ")}
                      >
                        <TableCell className="w-10 pr-0">
                          <GripVertical
                            className={`size-4 text-muted-foreground ${canDrag ? "cursor-grab" : "opacity-30"}`}
                            aria-label="Перетащить"
                          />
                        </TableCell>
                        <TableCell className="font-medium">
                          <span className="flex flex-wrap items-center gap-2">
                            {p.name}
                            {p.tag_text && <PackageTag text={p.tag_text} style={p.tag_style} />}
                          </span>
                        </TableCell>
                        <TableCell>
                          {p.kind !== "package" ? (
                            <Badge variant="outline">{MEMBERSHIP_KIND_LABEL[p.kind]}</Badge>
                          ) : (
                            <span className="text-muted-foreground">
                              {MEMBERSHIP_KIND_LABEL.package}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {trainingsLabel(p)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatDuration(p.duration_days)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatMoney(Number(p.price))}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {p.max_payments > 1 ? `до ${p.max_payments}` : "1"}
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate text-muted-foreground">
                          {p.description ? stripFormatting(p.description) : "—"}
                        </TableCell>
                        <TableCell>
                          {p.kind === "single" ? (
                            // Разовое в приложении не показывается — переключать нечего.
                            <Badge variant="outline">Не в приложении</Badge>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Switch
                                aria-label={`В приложении: ${p.name}`}
                                checked={p.is_active}
                                onCheckedChange={(v) => handleToggleActive(p, v)}
                              />
                              {p.is_active ? (
                                <StatusChip tone="positive">Активен</StatusChip>
                              ) : (
                                <StatusChip tone="neutral">Скрыт</StatusChip>
                              )}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    </RowContextMenu>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </RequireStudio>
      </div>

      <PackageDialog
        open={open}
        onOpenChange={setOpen}
        studioId={studioId}
        item={editing}
        draft={draft}
        nextSortOrder={items.reduce((m, p) => Math.max(m, p.sort_order), 0) + 1}
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
  /** Редактируемая запись; null — создание новой. */
  item: Package | null;
  /** Предзаполнение новой записи (дублирование). */
  draft: PackageDraft | null;
  /** sort_order новой записи — в конец списка. */
  nextSortOrder: number;
  onSaved: () => void;
};

function PackageDialog(props: DialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <PackageForm key={props.item?.id ?? "new"} {...props} />
      </DialogContent>
    </Dialog>
  );
}

/** Целое число больше 0 из поля ввода; иначе null. */
function positiveInt(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
}

function PackageForm({ onOpenChange, studioId, item, draft, nextSortOrder, onSaved }: DialogProps) {
  const init = item ?? draft;
  const [name, setName] = useState(init?.name ?? "");
  const [description, setDescription] = useState(init?.description ?? "");
  const [visitsCount, setVisitsCount] = useState(
    init?.visits_count != null && init.kind !== "personal" ? String(init.visits_count) : "",
  );
  // У пакета тренировок — подарочные персональные, у пакета персональных —
  // их количество (одно поле в БД: personal_count).
  const [giftPersonal, setGiftPersonal] = useState(
    init?.kind === "package" && init.personal_count ? String(init.personal_count) : "",
  );
  const [personalCount, setPersonalCount] = useState(
    init?.kind === "personal" ? String(init.personal_count) : "",
  );
  const [diagnosticsCount, setDiagnosticsCount] = useState(
    init?.kind !== "trial" && init?.diagnostics_count ? String(init.diagnostics_count) : "",
  );
  const [durationDays, setDurationDays] = useState(
    init?.duration_days != null ? String(init.duration_days) : "",
  );
  const [price, setPrice] = useState(init?.price != null ? String(init.price) : "");
  const [kind, setKind] = useState<MembershipKind>(init?.kind ?? "package");
  const isSingle = kind === "single";
  const [maxPayments, setMaxPayments] = useState(String(init?.max_payments ?? 1));
  const [isActive, setIsActive] = useState(init?.is_active ?? true);
  const [tagText, setTagText] = useState(init?.tag_text ?? "");
  const [tagStyle, setTagStyle] = useState<TagStyle>(init?.tag_style ?? "soft");
  const [giftText, setGiftText] = useState(init?.gift_text ?? "");
  const [benefits, setBenefits] = useState<string[]>(init?.benefits ?? []);
  const tr = useContentTranslations(init?.translations);
  const { ruHint: benefitsRuHint, ...benefitsField } = tr.list(
    "benefits",
    benefits,
    setBenefits,
    "Например: 2 диагностики тела — и нажмите +",
  );
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!studioId) return;
    if (!name.trim()) {
      tr.setLang("ru");
      toast.error("Укажите название");
      return;
    }
    const isPersonal = kind === "personal";
    // У пакета персональных обычных тренировок нет (0): по нему нельзя
    // записаться на групповое. У разового условия постоянные (SINGLE_VISIT).
    const visits = isPersonal ? 0 : isSingle ? SINGLE_VISIT.visits : positiveInt(visitsCount);
    if (visits == null) {
      toast.error("Укажите количество тренировок (целое число больше 0)");
      return;
    }
    const personal = isPersonal
      ? positiveInt(personalCount)
      : kind === "package"
        ? giftPersonal.trim() === ""
          ? 0
          : positiveInt(giftPersonal)
        : 0;
    if (personal == null) {
      toast.error(
        isPersonal
          ? "Укажите количество персональных тренировок (целое число больше 0)"
          : "Персональных в подарок — целое число (0 — нет)",
      );
      return;
    }
    // Диагностики — у пакетов тренировок и персональных, у пробного и разового нет.
    const diagnostics =
      kind === "trial" || isSingle || diagnosticsCount.trim() === ""
        ? 0
        : Number(diagnosticsCount.trim());
    if (!Number.isInteger(diagnostics) || diagnostics < 0) {
      toast.error("Диагностик — целое число (0 — нет)");
      return;
    }
    const days = isSingle ? SINGLE_VISIT.durationDays : positiveInt(durationDays);
    if (days == null) {
      toast.error("Укажите срок действия в днях (целое число больше 0)");
      return;
    }
    const priceNum = Number(price.trim().replace(",", "."));
    if (price.trim() === "" || !Number.isFinite(priceNum) || priceNum < 0) {
      toast.error("Укажите стоимость");
      return;
    }
    // У пробного и разового посещения рассрочки нет — всегда один платёж.
    const payments =
      kind === "trial" || isSingle ? SINGLE_VISIT.payments : positiveInt(maxPayments);
    if (payments == null || payments > MAX_PAYMENTS_LIMIT) {
      toast.error(`Укажите число платежей — целое от 1 до ${MAX_PAYMENTS_LIMIT}`);
      return;
    }

    const translations = tr.cleaned();
    // Вид тега нужен, если тег есть хоть на одном языке.
    const hasTag =
      !!tagText.trim() ||
      TRANSLATED_LANGS.some((l) => translationText(translations, l, "tag_text"));

    setSaving(true);
    try {
      // Всё, чего у пакетов нет, — явно выключено: строка в общей таблице
      // memberships не должна унаследовать подписочные условия (автопродление
      // в пакетной студии выключает ещё и триггер в БД).
      const payload = {
        name: name.trim(),
        description: description.trim() || null,
        visits_count: visits,
        personal_count: personal,
        diagnostics_count: diagnostics,
        duration_days: days,
        price: priceNum,
        max_payments: payments,
        kind,
        // Разовое в приложении не показывается (его отсекает тип), is_active
        // ему не нужен — держим включённым.
        is_active: isSingle ? true : isActive,
        tag_text: tagText.trim() || null,
        tag_style: hasTag ? tagStyle : null,
        gift_text: giftText.trim() || null,
        auto_renew: false,
        installment_enabled: false,
        for_couple: false,
        freeze_days_allowed: 0,
        benefits,
        translations,
      };
      const { error } = item
        ? await supabase.from("memberships").update(payload).eq("id", item.id)
        : // Новая — в активном клубе (видна во всех пакетных); правка клуб строки не меняет.
          await supabase
            .from("memberships")
            .insert({ ...payload, studio_id: studioId, sort_order: nextSortOrder });
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success(item ? "Номенклатура обновлена" : "Номенклатура добавлена");
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  // Тег в предпросмотре — на языке формы; перевода нет — русский тег.
  const tagPreview = tr.input("tag_text", tagText, setTagText).value.trim() || tagText.trim();

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? "Редактировать номенклатуру" : "Новая номенклатура"}</DialogTitle>
        <DialogDescription>
          Пакет — несколько тренировок за фиксированную цену на ограниченный срок: групповых (пакет
          тренировок) или персональных с тренером (пакет персональных). Разовое посещение — одна
          групповая тренировка, продаёт администратор, в приложении его нет. Пробное посещение
          продаётся типом «Оплата пробного» в «Абонементах». Номенклатура общая для всех клубов с
          пакетами тренировок: изменения сразу видны во всех клубах.
        </DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            <FormField label="Тип" tip={TIPS.kind} htmlFor={null} required>
              <RadioGroup
                value={kind}
                onValueChange={(v) => {
                  setKind(v as MembershipKind);
                  // Разовое называется «Разовое посещение» — подставляем, если пусто.
                  if (v === "single" && !name.trim()) setName(SINGLE_VISIT.name);
                }}
                className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border p-3"
              >
                {MEMBERSHIP_KINDS.map((k) => (
                  <label key={k} className="flex cursor-pointer items-center gap-2 text-sm">
                    <RadioGroupItem value={k} />
                    <span>{MEMBERSHIP_KIND_LABEL[k]}</span>
                  </label>
                ))}
              </RadioGroup>
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Название</ContentLangLabel>}
              required={tr.lang === "ru"}
            >
              <Input
                {...tr.input(
                  "name",
                  name,
                  setName,
                  kind === "trial"
                    ? "Например: Пробное занятие"
                    : kind === "single"
                      ? SINGLE_VISIT.name
                      : kind === "personal"
                        ? "Например: 5 персональных"
                        : "Например: 8 тренировок",
                )}
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {kind === "personal" ? (
                <FormField label="Персональных" tip={TIPS.personal} required>
                  <Input
                    type="number"
                    min={1}
                    value={personalCount}
                    onChange={(e) => setPersonalCount(e.target.value)}
                    placeholder="5"
                  />
                </FormField>
              ) : (
                <FormField label="Тренировок" tip={isSingle ? TIPS.single : TIPS.visits} required>
                  <Input
                    type="number"
                    min={1}
                    value={isSingle ? String(SINGLE_VISIT.visits) : visitsCount}
                    onChange={(e) => setVisitsCount(e.target.value)}
                    placeholder="8"
                    disabled={isSingle}
                  />
                </FormField>
              )}
              <FormField label="Срок, дней" tip={isSingle ? TIPS.single : TIPS.duration} required>
                <Input
                  type="number"
                  min={1}
                  value={isSingle ? String(SINGLE_VISIT.durationDays) : durationDays}
                  onChange={(e) => setDurationDays(e.target.value)}
                  placeholder="30"
                  disabled={isSingle}
                />
              </FormField>
              <FormField label="Стоимость, ₾" tip={TIPS.price} required>
                <Input
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0"
                />
              </FormField>
            </div>

            {kind !== "trial" && !isSingle && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {kind === "package" && (
                  <FormField label="Персональных в подарок" tip={TIPS.giftPersonal} optional>
                    <Input
                      type="number"
                      min={0}
                      value={giftPersonal}
                      onChange={(e) => setGiftPersonal(e.target.value)}
                      placeholder="0"
                    />
                  </FormField>
                )}
                <FormField label="Диагностик" tip={TIPS.diagnostics} optional>
                  <Input
                    type="number"
                    min={0}
                    value={diagnosticsCount}
                    onChange={(e) => setDiagnosticsCount(e.target.value)}
                    placeholder="0"
                  />
                </FormField>
              </div>
            )}

            {kind !== "trial" && !isSingle && (
              <FormField
                label="Сколькими платежами можно оплатить"
                tip={TIPS.payments}
                hint="Платежи ежемесячные: первый — в день продажи, остаток делится на следующие."
                required
              >
                <Input
                  type="number"
                  min={1}
                  max={MAX_PAYMENTS_LIMIT}
                  value={maxPayments}
                  onChange={(e) => setMaxPayments(e.target.value)}
                  className="sm:w-32"
                />
              </FormField>
            )}

            {isSingle ? (
              <InfoNote>
                Разовое посещение в мобильном приложении не показывается и не продаётся: его
                оформляет администратор в «Абонементах» или в карточке клиента.
              </InfoNote>
            ) : (
              <>
                <FormField
                  label={<ContentLangLabel lang={tr.lang}>Описание</ContentLangLabel>}
                  tip={TIPS.description}
                  optional
                >
                  <FormattedTextarea
                    rows={4}
                    {...tr.text("description", description, setDescription)}
                  />
                </FormField>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
                  <FormField
                    label={<ContentLangLabel lang={tr.lang}>Тег</ContentLangLabel>}
                    tip={TIPS.tag}
                    optional
                  >
                    <Input
                      maxLength={24}
                      {...tr.input("tag_text", tagText, setTagText, "Например: Популярно")}
                    />
                  </FormField>
                  <FormField label="Вид тега" htmlFor={null}>
                    <SegmentedControl
                      aria-label="Вид тега"
                      value={tagStyle}
                      onChange={setTagStyle}
                      options={TAG_STYLES}
                    />
                  </FormField>
                </div>
                {tagPreview && (
                  <div className="-mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    В приложении: <PackageTag text={tagPreview} style={tagStyle} />
                  </div>
                )}

                <FormField
                  label={<ContentLangLabel lang={tr.lang}>Что входит</ContentLangLabel>}
                  tip={TIPS.benefits}
                  optional
                  hint={benefitsRuHint}
                >
                  {/* key: недописанный пункт не переезжает на другой язык. */}
                  <BenefitsEditor key={tr.lang} {...benefitsField} />
                </FormField>

                <FormField
                  label={<ContentLangLabel lang={tr.lang}>В подарок</ContentLangLabel>}
                  tip={TIPS.gift}
                  optional
                >
                  <FormattedTextarea rows={3} {...tr.text("gift_text", giftText, setGiftText)} />
                </FormField>

                <SwitchRow
                  title="Показывать в мобильном приложении"
                  hint="Выключите, чтобы пакет нельзя было купить. Уже купившие сохранят условия."
                  checked={isActive}
                  onCheckedChange={setIsActive}
                />
              </>
            )}

            {item && (
              <InfoNote variant="warning">
                Изменения цены и условий применятся ко всем будущим продажам этого пакета. Если у
                вас уже есть купившие, лучше нажмите «Дублировать» в списке, измените копию, а
                старую запись скройте переключателем выше.
              </InfoNote>
            )}
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

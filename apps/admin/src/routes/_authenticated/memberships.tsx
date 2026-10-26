import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2, X, Copy } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { RequireStudio } from "@/components/require-studio";
import { RequireFormat } from "@/components/require-format";
import { ImageUploadField, StorageImage } from "@/components/image-upload-field";
import { useActiveStudioId } from "@/hooks/use-active-studio";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { formatMoney } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormattedTextarea } from "@/components/formatted-textarea";
import { stripFormatting } from "@/lib/formatted-text";
import { BenefitsEditor } from "@/components/benefits-editor";
import { ContentLangLabel, ContentLangNote, ContentLangSwitch } from "@/components/content-lang";
import { useContentTranslations } from "@/hooks/use-content-translations";
import type { ContentTranslations } from "@/lib/content-i18n";
import { CheckboxOption, FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
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
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
import { TableToolbar, ToolbarSearch } from "@/components/table-toolbar";
import { TableSkeletonRows } from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { MembershipsPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  description:
    "Видно клиентам в карточке абонемента в приложении. Можно выделять жирным, делать списки и ссылки.",
  benefits:
    "Пункты списка в карточке в приложении. Заморозку не добавляйте — строка «Заморозка до N дней» появится сама.",
  visits: "Сколько занятий в пакете. В приложении безлимиты и пакеты — на разных вкладках.",
  duration: "Считается от даты продажи. Пусто — абонемент бессрочный.",
  autoRenew:
    "Клиент может отключить продление в приложении — отказы видны в «Отменах автопродления».",
  installment: "При продаже оплату можно разбить: первый взнос + 2–3 платежа раз в месяц.",
  price:
    "Подставляется в продажу, там её можно снизить для скидки. На уже проданные абонементы не влияет.",
};

export const Route = createFileRoute("/_authenticated/memberships")({
  head: () => ({ meta: [{ title: "Номенклатуры — Base40 Admin" }] }),
  pendingComponent: MembershipsPageSkeleton,
  component: MembershipsRoute,
});

/** Номенклатура подписочного формата; у пакетных студий своя — packages.tsx. */
function MembershipsRoute() {
  return (
    <RequireFormat format="subscription" title="Номенклатуры" other={{ packages: "/packages" }}>
      <MembershipsPage />
    </RequireFormat>
  );
}

type Membership = {
  id: string;
  studio_id: string;
  name: string;
  description: string | null;
  benefits: string[];
  visits_count: number | null;
  duration_days: number | null;
  auto_renew: boolean;
  installment_enabled: boolean;
  price: number;
  is_active: boolean;
  cover_url: string | null;
  for_couple: boolean;
  freeze_days_allowed: number;
  /** Переводы для приложения: {en|ka: {name, description, benefits[]}}. */
  translations: ContentTranslations;
};

/** Поля, которыми можно предзаполнить новый абонемент (дублирование). */
type MembershipDraft = Omit<Membership, "id" | "studio_id">;

/** Сортировка колонок (lib/table-sort.ts); безлимит — больше любого числа. */
const SORT_GETTERS: SortGetters<Membership> = {
  cover: (m) => Boolean(m.cover_url),
  name: (m) => m.name,
  description: (m) => (m.description ? stripFormatting(m.description) : null),
  benefits: (m) => m.benefits?.length || null,
  visits: (m) => m.visits_count ?? Number.POSITIVE_INFINITY,
  duration: (m) => m.duration_days || null,
  autoRenew: (m) => m.auto_renew,
  installment: (m) => m.installment_enabled,
  price: (m) => Number(m.price),
  status: (m) => m.is_active,
};

function formatDuration(days: number | null) {
  if (!days) return "—";
  if (days % 365 === 0) return `${days / 365} г.`;
  if (days % 30 === 0) return `${days / 30} мес.`;
  return `${days} дн.`;
}

function MembershipsPage() {
  const { confirm, confirmDialog } = useConfirm();
  const studioId = useActiveStudioId();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Membership | null>(null);
  const [draft, setDraft] = useState<MembershipDraft | null>(null);

  const { data: items = [], isLoading: loading } = useQuery({
    queryKey: ["memberships", studioId],
    queryFn: () =>
      unwrap<Membership[]>(
        supabase
          .from("memberships")
          .select("*")
          .eq("studio_id", studioId!)
          .order("created_at", { ascending: false }),
      ),
    enabled: !!studioId,
    meta: { errorMessage: "Не удалось загрузить номенклатуры" },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: ["memberships"] });

  const handleDelete = async (m: Membership) => {
    if (
      !(await confirm({
        title: "Удалить абонемент?",
        description: `«${m.name}» пропадёт из каталога. Если его уже продавали, удалить не получится — тогда скройте его переключателем в колонке «Статус».`,
      }))
    )
      return;
    const { error } = await supabase.from("memberships").delete().eq("id", m.id);
    if (error) {
      // 23503 — на номенклатуру ссылаются продажи и абонементы клиентов
      // (внешний ключ on delete restrict): удалять проданное нельзя.
      toast.error(
        error.code === "23503"
          ? "Этот абонемент уже продавали — удалить нельзя, пропала бы история продаж. Скройте его переключателем в колонке «Статус»."
          : "Ошибка удаления: " + error.message,
      );
      return;
    }
    toast.success("Номенклатура удалена");
    reload();
  };

  const handleToggleActive = async (m: Membership, next: boolean) => {
    const { error } = await supabase.from("memberships").update({ is_active: next }).eq("id", m.id);
    if (error) {
      toast.error("Не удалось изменить статус: " + error.message);
      return;
    }
    toast.success(next ? "Абонемент активен" : "Абонемент скрыт в приложении");
    reload();
  };

  const openCreate = (initial: MembershipDraft | null = null) => {
    setEditing(null);
    setDraft(initial);
    setOpen(true);
  };
  const openEdit = (m: Membership) => {
    setEditing(m);
    setDraft(null);
    setOpen(true);
  };

  const q = search.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (m) => m.name.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q),
      )
    : items;

  const sort = useTableSort(SORT_GETTERS);
  const pg = usePagination(sort.apply(filtered), undefined, sort.key);

  return (
    <AdminShell
      title="Номенклатуры"
      actions={
        <Button onClick={() => openCreate()} disabled={!studioId}>
          <Plus />
          Добавить абонемент
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
                  <TableHead className="w-[80px]" {...sort.head("cover")}>
                    Обложка
                  </TableHead>
                  <TableHead {...sort.head("name")}>Название</TableHead>
                  <TableHead tip={TIPS.description} {...sort.head("description")}>
                    Описание
                  </TableHead>
                  <TableHead tip={TIPS.benefits} {...sort.head("benefits")}>
                    Преимущества
                  </TableHead>
                  <TableHead tip={TIPS.visits} {...sort.head("visits")}>
                    Посещения
                  </TableHead>
                  <TableHead tip={TIPS.duration} {...sort.head("duration")}>
                    Срок
                  </TableHead>
                  <TableHead tip={TIPS.autoRenew} {...sort.head("autoRenew")}>
                    Автопродление
                  </TableHead>
                  <TableHead tip={TIPS.installment} {...sort.head("installment")}>
                    Рассрочка
                  </TableHead>
                  <TableHead className="text-right" tip={TIPS.price} {...sort.head("price")}>
                    Цена
                  </TableHead>
                  <TableHead {...sort.head("status")}>Статус</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeletonRows columns={10} />
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={10}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      {items.length === 0
                        ? "Пока нет абонементов. Нажмите «Добавить абонемент»."
                        : "Ничего не найдено."}
                    </TableCell>
                  </TableRow>
                ) : (
                  pg.paged.map((m) => (
                    <RowContextMenu
                      key={m.id}
                      actions={[
                        {
                          label: "Дублировать",
                          icon: Copy,
                          onSelect: () =>
                            openCreate({ ...m, name: `${m.name} (копия)`, is_active: true }),
                        },
                        { label: "Редактировать", icon: Pencil, onSelect: () => openEdit(m) },
                        {
                          label: "Удалить",
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => handleDelete(m),
                        },
                      ]}
                    >
                      <TableRow className={m.is_active ? "" : "opacity-60"}>
                        <TableCell>
                          <CoverImage value={m.cover_url} alt={m.name} />
                        </TableCell>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <span>{m.name}</span>
                            {m.for_couple && <Badge variant="outline">Для двоих</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[260px] truncate text-muted-foreground">
                          {m.description ? stripFormatting(m.description) : "—"}
                        </TableCell>
                        <TableCell>
                          {m.benefits?.length ? (
                            <ul className="list-disc space-y-0.5 pl-4 text-xs">
                              {m.benefits.map((b, i) => (
                                <li key={i}>{b}</li>
                              ))}
                            </ul>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {m.visits_count == null ? "Безлимит" : m.visits_count}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatDuration(m.duration_days)}
                        </TableCell>
                        <TableCell>{m.auto_renew ? "Да" : "Нет"}</TableCell>
                        <TableCell>{m.installment_enabled ? "Да" : "Нет"}</TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatMoney(Number(m.price))}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Switch
                              aria-label={`В приложении: ${m.name}`}
                              checked={m.is_active}
                              onCheckedChange={(v) => handleToggleActive(m, v)}
                            />
                            {m.is_active ? (
                              <StatusChip tone="positive">Активен</StatusChip>
                            ) : (
                              <StatusChip tone="neutral">Скрыт</StatusChip>
                            )}
                          </div>
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

      <MembershipDialog
        open={open}
        onOpenChange={setOpen}
        studioId={studioId}
        item={editing}
        draft={draft}
        onSaved={reload}
      />
      {confirmDialog}
    </AdminShell>
  );
}

/** Обложка целиком (часто это SVG-логотип), поэтому contain и рамка, а не cover. */
function CoverImage({
  value,
  alt,
  className,
}: {
  value: string | null;
  alt: string;
  className?: string;
}) {
  return (
    <StorageImage
      bucket="memberships"
      value={value}
      alt={alt}
      className={className}
      imgClassName="border bg-background object-contain"
    />
  );
}

type DialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  studioId: string | null;
  /** Редактируемая запись; null — создание новой. */
  item: Membership | null;
  /** Предзаполнение новой записи (дублирование). */
  draft: MembershipDraft | null;
  onSaved: () => void;
};

function MembershipDialog(props: DialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <MembershipForm key={props.item?.id ?? "new"} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function MembershipForm({ onOpenChange, studioId, item, draft, onSaved }: DialogProps) {
  const init = item ?? draft;
  const [name, setName] = useState(init?.name ?? "");
  const [description, setDescription] = useState(init?.description ?? "");
  const [benefits, setBenefits] = useState<string[]>(init?.benefits ?? []);
  const [unlimited, setUnlimited] = useState(init ? init.visits_count == null : false);
  const [visitsCount, setVisitsCount] = useState(
    init?.visits_count != null ? String(init.visits_count) : "",
  );
  const [durationDays, setDurationDays] = useState(
    init?.duration_days != null ? String(init.duration_days) : "",
  );
  const [autoRenew, setAutoRenew] = useState(init?.auto_renew ?? false);
  const [installmentEnabled, setInstallmentEnabled] = useState(init?.installment_enabled ?? false);
  const [price, setPrice] = useState(init?.price != null ? String(init.price) : "");
  const [freezeDays, setFreezeDays] = useState(
    init?.freeze_days_allowed ? String(init.freeze_days_allowed) : "",
  );
  const [isActive, setIsActive] = useState(init?.is_active ?? true);
  const [coverUrl, setCoverUrl] = useState(init?.cover_url ?? null);
  const [forCouple, setForCouple] = useState(init?.for_couple ?? false);
  const tr = useContentTranslations(init?.translations);
  const [saving, setSaving] = useState(false);

  const { ruHint: benefitsRuHint, ...benefitsField } = tr.list("benefits", benefits, setBenefits);

  const handleSave = async () => {
    if (!studioId) return;
    if (!name.trim()) {
      tr.setLang("ru");
      toast.error("Укажите название");
      return;
    }
    // null в visits_count — это безлимит. Пустое поле при снятой галочке
    // раньше молча превращало абонемент в безлимитный.
    let visits: number | null = null;
    if (!unlimited) {
      const n = Number(visitsCount.trim());
      if (visitsCount.trim() === "" || !Number.isInteger(n) || n <= 0) {
        toast.error("Укажите количество посещений (целое число больше 0) или отметьте «Безлимит»");
        return;
      }
      visits = n;
    }
    // Пустая цена раньше сохранялась как 0 — бесплатный абонемент по ошибке.
    const priceNum = Number(price.trim());
    if (price.trim() === "" || !Number.isFinite(priceNum) || priceNum < 0) {
      toast.error("Укажите цену");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        studio_id: studioId,
        name: name.trim(),
        description: description.trim() || null,
        benefits,
        translations: tr.cleaned(),
        visits_count: visits,
        duration_days: durationDays ? Number(durationDays) : null,
        auto_renew: autoRenew,
        installment_enabled: installmentEnabled,
        price: priceNum,
        freeze_days_allowed: freezeDays ? Number(freezeDays) : 0,
        is_active: isActive,
        cover_url: coverUrl,
        for_couple: forCouple,
      };
      const { error } = item
        ? await supabase.from("memberships").update(payload).eq("id", item.id)
        : await supabase.from("memberships").insert(payload);
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success(item ? "Абонемент обновлён" : "Абонемент добавлен");
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? "Редактировать абонемент" : "Новый абонемент"}</DialogTitle>
        <DialogDescription>Заполните параметры номенклатуры.</DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            <FormField
              label={<ContentLangLabel lang={tr.lang}>Название</ContentLangLabel>}
              required={tr.lang === "ru"}
            >
              <Input {...tr.input("name", name, setName, "Например: Безлимит на месяц")} />
            </FormField>

            <FormField
              label="Обложка"
              htmlFor={null}
              optional
              hint="Для мобильного приложения. Соотношение 3:2 (горизонтальное), оптимально 1200 × 800 px."
            >
              <ImageUploadField
                bucket="memberships"
                folder={`${studioId}/cover`}
                value={coverUrl}
                onChange={setCoverUrl}
                preview={<CoverImage value={coverUrl} alt="Обложка" className="h-16 w-24" />}
                accept="image/svg+xml,image/png,image/jpeg,image/webp"
                disabled={!studioId}
              />
            </FormField>

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

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Преимущества</ContentLangLabel>}
              tip={TIPS.benefits}
              optional
              hint={benefitsRuHint}
            >
              {/* key: недописанный пункт не переезжает на другой язык. */}
              <BenefitsEditor key={tr.lang} {...benefitsField} />
            </FormField>

            <FormField label="Количество посещений" tip={TIPS.visits} required={!unlimited}>
              <div className="flex items-center gap-4">
                <Input
                  type="number"
                  min={0}
                  value={visitsCount}
                  onChange={(e) => setVisitsCount(e.target.value)}
                  disabled={unlimited}
                  placeholder="Например, 8"
                  className="flex-1"
                />
                <CheckboxOption checked={unlimited} onCheckedChange={setUnlimited}>
                  Безлимит
                </CheckboxOption>
              </div>
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Срок действия, дней" tip={TIPS.duration} optional>
                <Input
                  type="number"
                  min={0}
                  value={durationDays}
                  onChange={(e) => setDurationDays(e.target.value)}
                  placeholder="30"
                />
              </FormField>
              <FormField label="Цена, ₾" tip={TIPS.price} required>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0"
                />
              </FormField>
            </div>

            <FormField
              label="Дней заморозки"
              tip="Замораживает сотрудник — в карточке клиента. Срок действия продлевается на дни заморозки."
              optional
              hint="Сколько дней клиент может заморозить этот абонемент суммарно. 0 — заморозка недоступна."
            >
              <Input
                type="number"
                min={0}
                value={freezeDays}
                onChange={(e) => setFreezeDays(e.target.value)}
                placeholder="0"
              />
            </FormField>

            <SwitchRow
              title="Автопродление"
              tip={TIPS.autoRenew}
              checked={autoRenew}
              onCheckedChange={setAutoRenew}
            />

            <SwitchRow
              title="Рассрочка доступна"
              tip={TIPS.installment}
              checked={installmentEnabled}
              onCheckedChange={setInstallmentEnabled}
            />

            <SwitchRow
              title="Абонемент для двоих"
              hint="Такие абонементы попадут в отдельную вкладку «Для двоих» в мобильном приложении."
              checked={forCouple}
              onCheckedChange={setForCouple}
            />

            <SwitchRow
              title="Показывать в мобильном приложении"
              hint="Выключите, чтобы новые клиенты не могли его купить. Уже купившие сохранят условия."
              checked={isActive}
              onCheckedChange={setIsActive}
            />

            {item && (
              <InfoNote variant="warning">
                Изменения цены и условий применятся ко всем будущим продажам этого абонемента. Если
                у вас уже есть купившие, лучше нажмите «Дублировать» в списке, измените копию, а
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

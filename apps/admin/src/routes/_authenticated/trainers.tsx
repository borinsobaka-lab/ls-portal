import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2, MessageCircle } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { StaffTabs } from "@/components/staff-tabs";
import { ImageUploadField } from "@/components/image-upload-field";
import { FormattedTextarea } from "@/components/formatted-textarea";
import { ContentLangLabel, ContentLangNote, ContentLangSwitch } from "@/components/content-lang";
import { useContentTranslations } from "@/hooks/use-content-translations";
import { useStudios } from "@/hooks/use-studios";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { isHttpUrl } from "@/lib/format";
import { EmployeePhoto, TrainerRoleBadge } from "@/components/employee-photo";
import {
  BANKS,
  TRAINER_ROLES,
  bankLabel,
  bankOf,
  formatIban,
  hasRating,
  useEmployees,
  type Employee,
  type TrainerRole,
} from "@/lib/staff-directory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckboxOption, FormField, InfoNote } from "@/components/ui/form-field";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
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
import { TableSkeletonRows } from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { TrainersPageSkeleton } from "@/components/page-skeletons";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  name: "Имя тренера клиенты видят в расписании приложения.",
  role: "Кем работает сотрудник. Доступ в админку выдаётся отдельно — в «Доступах».",
  studios: "Где работает сотрудник. Только в этих клубах его можно поставить на занятие.",
  bio: "Описание — клиенты читают его в приложении: «Студия» → «Тренеры», «Администраторы» или «Массажисты». Можно выделять жирным, делать списки и ссылки.",
  rating:
    "Средняя оценка до сотых и число отзывов: отзывы из прежнего сервиса и оценки клиентов в приложении («Студия» → «Тренеры» / «Массажисты»). Администраторов клиенты не оценивают.",
  ratingBase:
    "Рейтинг из прежнего сервиса — считается как уже оставленные отзывы, к нему добавляются оценки клиентов в приложении.",
  tip: "Ссылка на сервис чаевых — в карточке сотрудника в приложении появится кнопка «Поблагодарить».",
  bank: "Для выплат сотруднику. Видят только сотрудники, клиентам в приложении они недоступны.",
};

export const Route = createFileRoute("/_authenticated/trainers")({
  head: () => ({ meta: [{ title: "Сотрудники — Lady Stretch" }] }),
  pendingComponent: TrainersPageSkeleton,
  component: StaffPage,
});

/**
 * «Сотрудники» — справочник тренеров, администраторов и массажистов над студиями
 * (lib/staff-directory.ts): карточка, студии, реквизиты. Ставки — соседняя
 * страница раздела, «Зарплатные ставки» (pay-rates.tsx). Доступ в админку —
 * отдельно, в «Доступах».
 */

/** Грузинский IBAN без пробелов, в верхнем регистре. */
const normalizeIban = (v: string) => v.replace(/\s+/g, "").toUpperCase();

/** GE + 2 контрольные цифры + 2 буквы банка + 16 цифр счёта, контрольная сумма mod 97. */
function isValidGeIban(iban: string) {
  if (!/^GE\d{2}[A-Z]{2}\d{16}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

/** Подпись поля описания — по роли (в приложении карточка своя у каждой вкладки). */
const BIO_LABEL: Record<TrainerRole, string> = {
  trainer: "О тренере",
  admin: "Об администраторе",
  senior_admin: "О руководителе студии",
  masseur: "О массажисте",
};

const ratingFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Оценка и отзывы: 4,99 · 56. */
function RatingCell({ e }: { e: Employee }) {
  if (!hasRating(e.role)) return <span className="text-muted-foreground">—</span>;
  if (e.rating_avg == null || e.rating_count === 0) {
    return <span className="text-sm text-muted-foreground">Нет отзывов</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
      <svg viewBox="0 0 24 24" className="size-4 fill-amber-400" aria-hidden="true">
        <path d="M12 2.5l2.94 5.96 6.56.95-4.75 4.63 1.12 6.54L12 17.5l-5.87 3.08 1.12-6.54L2.5 9.41l6.56-.95z" />
      </svg>
      <span className="font-medium tabular-nums">{ratingFormat.format(Number(e.rating_avg))}</span>
      <span className="text-muted-foreground tabular-nums">· {e.rating_count}</span>
    </span>
  );
}

/** Сортировка колонок (lib/table-sort.ts). */
const SORT_GETTERS: SortGetters<Employee> = {
  name: (e) => e.full_name,
  role: (e) => TRAINER_ROLES[e.role]?.label ?? e.role,
  studios: (e) =>
    e.trainer_studios
      .map((s) => s.studio?.name ?? "")
      .sort()
      .join(", "),
  rating: (e) =>
    hasRating(e.role) && e.rating_avg != null && e.rating_count ? Number(e.rating_avg) : null,
  telegram: (e) => e.telegram,
  bank: (e) => bankLabel(bankOf(e)?.bank),
  account: (e) => bankOf(e)?.account_number,
  holder: (e) => bankOf(e)?.account_holder,
};

/** В поле — ссылка целиком или ник (с @ или без). */
function telegramHref(value: string) {
  const nick = value.replace(/^@/, "");
  return isHttpUrl(value) ? value : `https://t.me/${nick}`;
}

function StaffPage() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Employee | null>(null);
  const queryClient = useQueryClient();

  const { data: employees = [], isLoading } = useEmployees();
  const reload = () => {
    queryClient.invalidateQueries({ queryKey: ["trainers"] });
    // Роль и студии сотрудника меняют «Зарплаты».
    queryClient.invalidateQueries({ queryKey: ["payroll_lines"] });
  };

  const openEdit = (e: Employee | null) => {
    setEditing(e);
    setOpen(true);
  };

  return (
    <AdminShell
      title="Сотрудники"
      actions={
        <Button onClick={() => openEdit(null)}>
          <Plus />
          Добавить сотрудника
        </Button>
      }
    >
      <div className="space-y-3">
        <StaffTabs />
        <EmployeesTable
          employees={employees}
          loading={isLoading}
          onEdit={openEdit}
          onChanged={reload}
        />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
          <EmployeeForm
            key={editing?.id ?? "new"}
            employee={editing}
            onClose={() => setOpen(false)}
            onSaved={reload}
          />
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function EmployeesTable({
  employees,
  loading,
  onEdit,
  onChanged,
}: {
  employees: Employee[];
  loading: boolean;
  onEdit: (e: Employee) => void;
  onChanged: () => void;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const sort = useTableSort(SORT_GETTERS);
  const pg = usePagination(sort.apply(employees), undefined, sort.key);

  const handleDelete = async (e: Employee) => {
    if (
      !(await confirm({
        title: "Удалить сотрудника?",
        description: `«${e.full_name}» будет удалён из всех клубов и из расписания вместе с реквизитами и ставками, без возможности восстановления.`,
      }))
    )
      return;
    const { error } = await supabase.from("trainers").delete().eq("id", e.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success("Сотрудник удалён");
    onChanged();
  };

  return (
    <div className="rounded-lg border bg-background">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[80px]">Фото</TableHead>
            <TableHead tip={TIPS.name} {...sort.head("name")}>
              Имя
            </TableHead>
            <TableHead tip={TIPS.role} {...sort.head("role")}>
              Роль
            </TableHead>
            <TableHead tip={TIPS.studios} {...sort.head("studios")}>
              Клубы
            </TableHead>
            <TableHead tip={TIPS.rating} {...sort.head("rating")}>
              Рейтинг
            </TableHead>
            <TableHead {...sort.head("telegram")}>Telegram</TableHead>
            <TableHead tip={TIPS.bank} {...sort.head("bank")}>
              Банк
            </TableHead>
            <TableHead tip={TIPS.bank} {...sort.head("account")}>
              Счёт
            </TableHead>
            <TableHead tip={TIPS.bank} {...sort.head("holder")}>
              Владелец счёта
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableSkeletonRows columns={9} />
          ) : employees.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="py-8 text-center text-sm text-muted-foreground">
                Пока нет сотрудников. Нажмите «Добавить сотрудника».
              </TableCell>
            </TableRow>
          ) : (
            pg.paged.map((e) => {
              const bank = bankOf(e);
              return (
                <RowContextMenu
                  key={e.id}
                  actions={[
                    { label: "Редактировать", icon: Pencil, onSelect: () => onEdit(e) },
                    {
                      label: "Удалить",
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => handleDelete(e),
                    },
                  ]}
                >
                  <TableRow>
                    <TableCell>
                      <EmployeePhoto value={e.photo_url} name={e.full_name} />
                    </TableCell>
                    <TableCell className="font-medium">{e.full_name}</TableCell>
                    <TableCell>
                      <TrainerRoleBadge role={e.role} />
                    </TableCell>
                    <TableCell>
                      {e.trainer_studios.length ? (
                        <div className="flex flex-wrap gap-1">
                          {e.trainer_studios.map((s) => (
                            <Badge key={s.studio_id} variant="secondary">
                              {s.studio?.name ?? "—"}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Не выбраны</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <RatingCell e={e} />
                    </TableCell>
                    <TableCell>
                      {e.telegram ? (
                        <a
                          href={telegramHref(e.telegram)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 text-sm text-link hover:text-link-hover hover:underline"
                        >
                          <MessageCircle className="h-3.5 w-3.5 shrink-0" />
                          {e.telegram}
                        </a>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell>{bankLabel(bank?.bank) ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs whitespace-nowrap">
                      {bank?.account_number ? formatIban(bank.account_number) : "—"}
                    </TableCell>
                    <TableCell>{bank?.account_holder ?? "—"}</TableCell>
                  </TableRow>
                </RowContextMenu>
              );
            })
          )}
        </TableBody>
      </Table>
      <DataPagination {...pg} loading={loading} />
      {confirmDialog}
    </div>
  );
}

function EmployeeForm({
  employee,
  onClose,
  onSaved,
}: {
  employee: Employee | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Отмечать можно студии, где вы сотрудник (так же проверяет RLS);
  // остальные студии сотрудника показаны неактивными и сохраняются как есть.
  const { data: myStudios = [] } = useStudios();
  const bank = bankOf(employee);
  const initialStudioIds = employee?.trainer_studios.map((s) => s.studio_id) ?? [];

  const [role, setRole] = useState<TrainerRole>(employee?.role ?? "trainer");
  const [fullName, setFullName] = useState(employee?.full_name ?? "");
  const [telegram, setTelegram] = useState(employee?.telegram ?? "");
  const [photoUrl, setPhotoUrl] = useState(employee?.photo_url ?? null);
  const [bio, setBio] = useState(employee?.bio ?? "");
  const [tipUrl, setTipUrl] = useState(employee?.tip_url ?? "");
  const [baseAvg, setBaseAvg] = useState(
    employee?.rating_base_count ? String(employee.rating_base_avg ?? "").replace(".", ",") : "",
  );
  const [baseCount, setBaseCount] = useState(
    employee?.rating_base_count ? String(employee.rating_base_count) : "",
  );
  const [studioIds, setStudioIds] = useState<string[]>(initialStudioIds);
  const [bankCode, setBankCode] = useState<string>(bank?.bank ?? "");
  const [accountNumber, setAccountNumber] = useState(
    bank?.account_number ? formatIban(bank.account_number) : "",
  );
  const [accountHolder, setAccountHolder] = useState(bank?.account_holder ?? "");
  const tr = useContentTranslations(employee?.translations);
  const [saving, setSaving] = useState(false);

  const manageable = new Set(myStudios.map((s) => s.id));
  const otherStudios = (employee?.trainer_studios ?? []).filter(
    (s) => !manageable.has(s.studio_id),
  );

  const toggleStudio = (id: string, checked: boolean) =>
    setStudioIds((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));

  const handleAccountChange = (value: string) => {
    setAccountNumber(value);
    // Банк по коду в IBAN, если его ещё не выбрали руками.
    if (!bankCode) {
      const code = normalizeIban(value).slice(4, 6);
      const match = BANKS.find((b) => b.iban === code);
      if (match) setBankCode(match.value);
    }
  };

  const handleSave = async () => {
    const name = fullName.trim();
    const iban = normalizeIban(accountNumber);
    if (!name) {
      tr.setLang("ru");
      toast.error("Укажите имя");
      return;
    }
    if (studioIds.length === 0) {
      toast.error("Отметьте хотя бы один клуб");
      return;
    }
    const tip = tipUrl.trim();
    if (tip && !isHttpUrl(tip)) {
      toast.error("Ссылка на чаевые должна начинаться с https://");
      return;
    }
    // Прежний рейтинг: оба поля или ни одного.
    const avg = baseAvg.trim() ? Number(baseAvg.trim().replace(",", ".")) : null;
    const count = baseCount.trim() ? Number(baseCount.trim()) : 0;
    if (avg != null && !(avg >= 1 && avg <= 5)) {
      toast.error("Прежняя оценка — число от 1 до 5, например 4,98");
      return;
    }
    if (!Number.isInteger(count) || count < 0) {
      toast.error("Число прежних отзывов — целое, от 0");
      return;
    }
    if ((avg == null) !== (count === 0)) {
      toast.error("Для прежнего рейтинга укажите и оценку, и число отзывов");
      return;
    }
    if (iban && !isValidGeIban(iban)) {
      toast.error(
        "Номер счёта — грузинский IBAN: GE и 20 знаков, например GE29 NB00 0000 0101 9049 17",
      );
      return;
    }

    setSaving(true);
    try {
      const payload = {
        full_name: name,
        role,
        telegram: telegram.trim() || null,
        photo_url: photoUrl,
        bio: bio.trim() || null,
        translations: tr.cleaned(),
        tip_url: tip || null,
        rating_base_avg: avg == null ? null : Math.round(avg * 100) / 100,
        rating_base_count: count,
      };
      let id = employee?.id;
      if (id) {
        const { error } = await supabase.from("trainers").update(payload).eq("id", id);
        if (error) {
          toast.error("Ошибка сохранения: " + error.message);
          return;
        }
      } else {
        const { data, error } = await supabase
          .from("trainers")
          .insert(payload)
          .select("id")
          .single<{ id: string }>();
        if (error) {
          toast.error("Ошибка сохранения: " + error.message);
          return;
        }
        id = data.id;
      }

      // Строка сотрудника записана: дальше при ошибке закрываем форму
      // (повторное «Сохранить» нового сотрудника завело бы его дважды) и
      // обновляем список.
      const error = await saveLinks(id);
      if (error) toast.error("Сотрудник сохранён, но " + error);
      else toast.success(employee ? "Сохранено" : "Сотрудник добавлен");
      onClose();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  /** Студии и реквизиты сотрудника. Возвращает текст ошибки. */
  const saveLinks = async (id: string) => {
    // Студии: добавляем отмеченные, снимаем только свои снятые.
    const toAdd = studioIds.filter((s) => !initialStudioIds.includes(s));
    const toRemove = initialStudioIds.filter((s) => manageable.has(s) && !studioIds.includes(s));
    if (toAdd.length) {
      const { error } = await supabase
        .from("trainer_studios")
        .insert(toAdd.map((studio_id) => ({ trainer_id: id, studio_id })));
      if (error) return "клубы не привязаны: " + error.message;
    }
    if (toRemove.length) {
      const { error } = await supabase
        .from("trainer_studios")
        .delete()
        .eq("trainer_id", id)
        .in("studio_id", toRemove);
      if (error) return "клубы не отвязаны: " + error.message;
    }

    // Реквизиты: все поля пустые — строку удаляем, иначе upsert.
    const iban = normalizeIban(accountNumber);
    const holder = accountHolder.trim();
    const { error } =
      !bankCode && !iban && !holder
        ? await supabase.from("trainer_bank_details").delete().eq("trainer_id", id)
        : await supabase.from("trainer_bank_details").upsert({
            trainer_id: id,
            bank: bankCode || null,
            account_number: iban || null,
            account_holder: holder || null,
            updated_at: new Date().toISOString(),
          });
    return error ? "реквизиты не сохранены: " + error.message : null;
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{employee ? "Редактировать сотрудника" : "Новый сотрудник"}</DialogTitle>
        <DialogDescription>
          Сотрудник общий для клубов: отметьте, где он работает, — в расписании клуба можно выбрать
          только его сотрудников.
        </DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            <FormField label="Аватарка" htmlFor={null} optional>
              <ImageUploadField
                bucket="trainers"
                folder="trainers"
                value={photoUrl}
                onChange={setPhotoUrl}
                preview={
                  <EmployeePhoto value={photoUrl} name={fullName || "?"} className="size-16" />
                }
              />
            </FormField>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                label={<ContentLangLabel lang={tr.lang}>Имя</ContentLangLabel>}
                tip={TIPS.name}
                required={tr.lang === "ru"}
              >
                <Input {...tr.input("full_name", fullName, setFullName, "Иван Иванов")} />
              </FormField>
              <FormField label="Роль" tip={TIPS.role} required>
                <Select value={role} onValueChange={(v) => setRole(v as TrainerRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TRAINER_ROLES) as TrainerRole[]).map((r) => (
                      <SelectItem key={r} value={r}>
                        {TRAINER_ROLES[r].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>

            <FormField label="Telegram" optional>
              <Input
                value={telegram}
                onChange={(e) => setTelegram(e.target.value)}
                placeholder="@username или ссылка"
              />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>{BIO_LABEL[role]}</ContentLangLabel>}
              tip={TIPS.bio}
              optional
            >
              <FormattedTextarea
                {...tr.text("bio", bio, setBio, "Опыт, специализация, достижения…")}
              />
            </FormField>

            <FormField label="Ссылка на чаевые" tip={TIPS.tip} optional>
              <Input
                value={tipUrl}
                onChange={(e) => setTipUrl(e.target.value)}
                placeholder="https://…"
                inputMode="url"
              />
            </FormField>

            {hasRating(role) && (
              <FormField
                label="Рейтинг из прежнего сервиса"
                tip={TIPS.ratingBase}
                htmlFor={null}
                optional
                hint={
                  employee && employee.rating_count > 0
                    ? `Сейчас в приложении: ${ratingFormat.format(Number(employee.rating_avg))} · ${employee.rating_count} отз. (вместе с оценками клиентов)`
                    : undefined
                }
              >
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    value={baseAvg}
                    onChange={(e) => setBaseAvg(e.target.value)}
                    placeholder="Оценка, 4,98"
                    inputMode="decimal"
                    aria-label="Прежняя оценка"
                  />
                  <Input
                    value={baseCount}
                    onChange={(e) => setBaseCount(e.target.value)}
                    placeholder="Отзывов, 56"
                    inputMode="numeric"
                    aria-label="Число прежних отзывов"
                  />
                </div>
              </FormField>
            )}

            <FormField label="Клубы" tip={TIPS.studios} htmlFor={null} required>
              {myStudios.length === 0 && otherStudios.length === 0 ? (
                <InfoNote variant="empty">Нет клубов — заведите их в разделе «Клубы».</InfoNote>
              ) : (
                <div className="flex flex-wrap gap-x-4 gap-y-2 rounded-md border p-3">
                  {myStudios.map((s) => (
                    <CheckboxOption
                      key={s.id}
                      checked={studioIds.includes(s.id)}
                      onCheckedChange={(checked) => toggleStudio(s.id, checked)}
                    >
                      {s.name}
                    </CheckboxOption>
                  ))}
                  {otherStudios.map((s) => (
                    <CheckboxOption key={s.studio_id} checked disabled onCheckedChange={() => {}}>
                      {s.studio?.name ?? "Другой клуб"}
                    </CheckboxOption>
                  ))}
                </div>
              )}
            </FormField>

            <FormField label="Банковские реквизиты" htmlFor={null} optional tip={TIPS.bank}>
              <div className="space-y-3 rounded-md border p-3">
                <FormField label="Номер счёта" hint="Грузинский IBAN: GE и 20 знаков">
                  <Input
                    value={accountNumber}
                    onChange={(e) => handleAccountChange(e.target.value)}
                    placeholder="GE00 XX00 0000 0000 0000 00"
                    className="font-mono"
                    autoComplete="off"
                  />
                </FormField>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FormField label="Банк">
                    <Select value={bankCode} onValueChange={setBankCode}>
                      <SelectTrigger>
                        <SelectValue placeholder="Не выбран" />
                      </SelectTrigger>
                      <SelectContent>
                        {BANKS.map((b) => (
                          <SelectItem key={b.value} value={b.value}>
                            {b.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormField>
                  <FormField label="Владелец счёта">
                    <Input
                      value={accountHolder}
                      onChange={(e) => setAccountHolder(e.target.value)}
                      placeholder="Как в банке"
                      autoComplete="off"
                    />
                  </FormField>
                </div>
              </div>
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

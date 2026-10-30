import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsQuizPageSkeleton } from "@/components/page-skeletons";
import { TableSkeletonRows } from "@/components/skeletons";
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
import { FormField, InfoNote, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { StatTile } from "@/components/ui/stat-tile";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMsk } from "@/lib/analytics/core";
import { AN_TITLES } from "@/lib/analytics/labels";
import { checkQuizSheet } from "@/lib/analytics/quiz.functions";
import {
  invalidateQuiz,
  quizOverviewQuery,
  quizRpc,
  type QuizCityInput,
  type QuizCityRow,
  type QuizLocation,
} from "@/lib/analytics/quiz/data";
import { QUIZ_SHEET_NAME, quizSpreadsheetId } from "@/lib/analytics/quiz/rules";
import { plural } from "@/lib/payroll";

export const Route = createFileRoute("/_authenticated/analytics/quiz/")({
  head: () => ({ meta: [{ title: "Квиз-лендинги — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsQuizPageSkeleton,
  component: AnalyticsQuizPage,
});

const TIPS = {
  link: "Ссылка лендинга города для рекламы: открывается без входа. UTM-метки из ссылки уходят с заявкой.",
  sheet:
    "Google-таблица заявок города. Сервисный аккаунт Google (ключ — на странице «Источники СС») должен быть её редактором.",
  leads: "Заявок с этим городом, в скобках — ещё не записаны в таблицу.",
  slug: "Последняя часть ссылки: /quiz/<адрес>. Латинские буквы, цифры и дефис.",
  city: "Подпись на лендинге и город заявки — по нему заявка находит таблицу.",
  price: "Цена пробного занятия на обложке и на кнопке формы.",
  completed: "Под кнопкой обложки: «Уже прошли … девушек».",
  version: "Уходит с заявкой, как у них (в таблицу не пишется).",
  operator: "Оператор персональных данных — в политике конфиденциальности формы.",
  isDefault:
    "Открывается по ссылке /quiz без города и по неизвестному адресу (у них — Всеволожск).",
  spreadsheet: "ID таблицы или ссылка на неё. Пусто — заявки города ждут на портале.",
  sheetName: "Лист заявок. Нет такого листа — переименуется первый лист таблицы, как у них.",
};

/**
 * «Аналитика» → «Квиз» → «Квиз-лендинги» (администратору аналитики):
 * города их квиз-лендинга (config.js: город, студии, цена пробного,
 * оператор ПДн) и таблицы заявок (CITY_SHEETS). Сам лендинг —
 * /quiz/<город> (routes/quiz.$slug.tsx).
 */
function AnalyticsQuizPage() {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data, isPending, error } = useQuery(quizOverviewQuery);
  const [editing, setEditing] = useState<QuizCityRow | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const cities = data?.cities ?? [];

  const copy = async (c: QuizCityRow) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/quiz/${c.slug}`);
    } catch {
      toast.error("Не удалось скопировать — откройте ссылку и скопируйте адрес вручную.");
      return;
    }
    setCopied(c.id);
    setTimeout(() => setCopied((v) => (v === c.id ? null : v)), 1600);
  };
  const check = async (c: QuizCityRow) => {
    setBusy(`check:${c.id}`);
    try {
      const r = await checkQuizSheet({ data: { spreadsheetId: c.spreadsheet_id } });
      const sheet = r.sheets.includes(c.sheet_name)
        ? `лист «${c.sheet_name}» есть`
        : `листа «${c.sheet_name}» нет — переименуется первый лист`;
      toast.success(`Таблица «${r.title}» доступна: ${sheet}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (c: QuizCityRow) => {
    const ok = await confirm({
      title: `Удалить город «${c.city}»?`,
      description:
        "Лендинг города перестанет открываться (по его ссылке откроется город по умолчанию). Заявки города останутся, но в таблицу больше не уйдут.",
      confirmLabel: "Удалить",
    });
    if (!ok) return;
    setBusy(`delete:${c.id}`);
    try {
      await quizRpc.removeCity(c.id);
      await invalidateQuiz(qc);
      toast.success("Город удалён.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AdminShell
      title={AN_TITLES.quiz}
      actions={
        <Button onClick={() => setEditing("new")}>
          <Plus />
          Новый город
        </Button>
      }
    >
      <div className="space-y-4">
        <InfoNote>
          Квиз-лендинг: три вопроса, рекомендация направления и заявка на пробное занятие. Заявка
          сначала сохраняется на портале, затем записывается в Google-таблицу своего города —
          задачей «Квиз: новые заявки в Google-таблицы городов» на странице{" "}
          <Link to="/analytics/admin/jobs" className="underline underline-offset-2">
            «Фоновые задачи»
          </Link>
          . Задача выключена: пока работает старый портал, он пишет в те же таблицы.
        </InfoNote>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Заявок всего" value={data?.total ?? 0} loading={isPending} />
          <StatTile label="Ждут записи в таблицу" value={data?.pending ?? 0} loading={isPending} />
          <StatTile
            label="С ошибкой записи"
            value={data?.errors ?? 0}
            tone={data?.errors ? "negative" : "default"}
            loading={isPending}
          />
          <StatTile
            className="col-span-2 lg:col-span-1"
            label="Последняя заявка"
            value={data?.last_at ? formatMsk(data.last_at) : "—"}
            loading={isPending}
          />
        </div>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <section className="rounded-lg border bg-background">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
              <div>
                <h2 className="text-lg font-semibold">Города лендинга</h2>
                <p className="text-sm text-muted-foreground">
                  Адреса и телефоны студий, цена пробного и оператор ПДн — то, что видит клиент.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {cities.length} {plural(cities.length, ["город", "города", "городов"])}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Город</TableHead>
                  <TableHead tip={TIPS.link}>Ссылка</TableHead>
                  <TableHead className="text-right">Пробное</TableHead>
                  <TableHead>Студии</TableHead>
                  <TableHead tip={TIPS.sheet}>Google-таблица</TableHead>
                  <TableHead tip={TIPS.leads} className="text-right">
                    Заявки
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  <TableSkeletonRows columns={7} rows={4} />
                ) : cities.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={7}
                      className="py-8 text-center text-sm text-muted-foreground"
                    >
                      Городов пока нет — добавьте первый.
                    </TableCell>
                  </TableRow>
                ) : (
                  cities.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="font-medium">{c.city}</div>
                        {c.is_default && (
                          <div className="mt-1">
                            <StatusChip tone="neutral">по умолчанию</StatusChip>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <a
                            href={`/quiz/${c.slug}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sm underline-offset-2 hover:underline"
                          >
                            /quiz/{c.slug}
                            <ExternalLink className="size-3.5" />
                          </a>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Скопировать ссылку"
                            aria-label="Скопировать ссылку"
                            onClick={() => void copy(c)}
                          >
                            {copied === c.id ? <Check /> : <Copy />}
                          </Button>
                        </div>
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {c.trial_price} ₽
                      </TableCell>
                      <TableCell className="max-w-64 text-sm">
                        {c.locations.length
                          ? c.locations.map((l, i) => (
                              <div key={i} className="truncate" title={l.address}>
                                {l.address}
                              </div>
                            ))
                          : "—"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.spreadsheet_id ? (
                          <>
                            <StatusChip tone="positive">настроена</StatusChip>
                            <div className="mt-1 text-xs text-muted-foreground">
                              лист «{c.sheet_name}»
                            </div>
                          </>
                        ) : (
                          <StatusChip tone="warning">не настроена</StatusChip>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        <Link
                          to="/analytics/quiz/leads"
                          search={{ city: c.city }}
                          className="underline-offset-2 hover:underline"
                        >
                          {c.leads}
                        </Link>
                        {c.pending > 0 && (
                          <span className="text-muted-foreground"> ({c.pending})</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-end gap-1">
                          {c.spreadsheet_id && (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              onClick={() => void check(c)}
                            >
                              {busy === `check:${c.id}` ? (
                                <Loader2 className="animate-spin" />
                              ) : (
                                <ShieldCheck />
                              )}
                              Проверить таблицу
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Изменить"
                            aria-label="Изменить"
                            disabled={busy !== null}
                            onClick={() => setEditing(c)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            title="Удалить город"
                            aria-label="Удалить город"
                            disabled={busy !== null}
                            onClick={() => void remove(c)}
                          >
                            {busy === `delete:${c.id}` ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Trash2 />
                            )}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </section>
        )}
      </div>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-2xl">
          {editing && (
            <CityForm
              key={editing === "new" ? "new" : editing.id}
              city={editing === "new" ? null : editing}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

const EMPTY_LOCATION: QuizLocation = {
  address: "",
  landmark: "",
  phone_display: "",
  phone_href: "",
};

/** Город лендинга: их config.js и CITY_SHEETS одним окном. */
function CityForm({ city, onClose }: { city: QuizCityRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<QuizCityInput>({
    slug: city?.slug ?? "",
    city: city?.city ?? "",
    trial_price: city ? String(city.trial_price) : "600",
    completed_count: city?.completed_count ?? "200+",
    landing_version: city?.landing_version ?? "",
    locations: city?.locations.length ? city.locations : [EMPTY_LOCATION],
    operator_name: city?.operator_name ?? "",
    operator_inn: city?.operator_inn ?? "",
    spreadsheet_id: city?.spreadsheet_id ?? "",
    sheet_name: city?.sheet_name ?? QUIZ_SHEET_NAME,
    is_default: city?.is_default ?? false,
  });
  const [saving, setSaving] = useState(false);
  const set =
    (k: "slug" | "city" | "trial_price" | "completed_count" | "landing_version") =>
    (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  const setText =
    (k: "operator_name" | "operator_inn" | "spreadsheet_id" | "sheet_name") =>
    (e: { target: { value: string } }) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));
  const setLocation = (i: number, k: keyof QuizLocation, value: string) =>
    setForm((f) => ({
      ...f,
      locations: f.locations.map((l, j) => (j === i ? { ...l, [k]: value } : l)),
    }));

  const save = async () => {
    setSaving(true);
    try {
      await quizRpc.saveCity(city?.id ?? null, {
        ...form,
        spreadsheet_id: quizSpreadsheetId(form.spreadsheet_id),
        // Пустые строки студий не сохраняем; ссылку телефона лендинг строит сам.
        locations: form.locations.filter(
          (l) => l.address.trim() || l.landmark.trim() || l.phone_display.trim(),
        ),
      });
      await invalidateQuiz(qc);
      toast.success(city ? "Город сохранён." : "Город добавлен.");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogForm onSubmit={save}>
      <DialogHeader>
        <DialogTitle>{city ? `Город «${city.city}»` : "Новый город лендинга"}</DialogTitle>
        <DialogDescription>
          Что видит клиент на лендинге города и куда записываются его заявки.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Город" required tip={TIPS.city}>
            <Input required value={form.city} onChange={set("city")} placeholder="Тюмень" />
          </FormField>
          <FormField label="Адрес страницы" required tip={TIPS.slug}>
            <Input
              required
              value={form.slug}
              onChange={set("slug")}
              placeholder="tyumen"
              autoCapitalize="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label="Цена пробного, ₽" required tip={TIPS.price}>
            <Input
              required
              inputMode="numeric"
              value={form.trial_price}
              onChange={set("trial_price")}
            />
          </FormField>
          <FormField label="«Уже прошли»" tip={TIPS.completed}>
            <Input value={form.completed_count} onChange={set("completed_count")} />
          </FormField>
          <FormField label="Версия лендинга" tip={TIPS.version}>
            <Input value={form.landing_version} onChange={set("landing_version")} />
          </FormField>
        </div>
        <SwitchRow
          title="Город по умолчанию"
          tip={TIPS.isDefault}
          checked={form.is_default}
          onCheckedChange={(v) => setForm((f) => ({ ...f, is_default: v }))}
        />
        <div className="space-y-2">
          <p className="text-sm font-medium">Студии города</p>
          {form.locations.map((l, i) => (
            <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto]">
              <Input
                aria-label="Адрес студии"
                placeholder="Адрес студии"
                value={l.address}
                onChange={(e) => setLocation(i, "address", e.target.value)}
                className="sm:col-span-2"
              />
              <Button
                size="icon"
                variant="ghost"
                title="Убрать студию"
                aria-label="Убрать студию"
                className="justify-self-end"
                onClick={() =>
                  setForm((f) => ({
                    ...f,
                    locations:
                      f.locations.length > 1
                        ? f.locations.filter((_, j) => j !== i)
                        : [EMPTY_LOCATION],
                  }))
                }
              >
                <X />
              </Button>
              <Input
                aria-label="Ориентир"
                placeholder="Ориентир (необязательно)"
                value={l.landmark}
                onChange={(e) => setLocation(i, "landmark", e.target.value)}
              />
              <Input
                aria-label="Телефон студии"
                placeholder="Телефон: +7 (900) 000-00-00"
                inputMode="tel"
                value={l.phone_display}
                onChange={(e) => {
                  setLocation(i, "phone_display", e.target.value);
                  setLocation(i, "phone_href", "");
                }}
              />
            </div>
          ))}
          {form.locations.length < 10 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setForm((f) => ({ ...f, locations: [...f.locations, EMPTY_LOCATION] }))
              }
            >
              <Plus />
              Ещё студия
            </Button>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Оператор ПДн" tip={TIPS.operator}>
            <Input
              value={form.operator_name}
              onChange={setText("operator_name")}
              placeholder="ИП Фамилия Имя Отчество"
            />
          </FormField>
          <FormField label="ИНН оператора">
            <Input
              inputMode="numeric"
              value={form.operator_inn}
              onChange={setText("operator_inn")}
            />
          </FormField>
          <FormField label="Google-таблица заявок" tip={TIPS.spreadsheet}>
            <Input
              value={form.spreadsheet_id}
              onChange={setText("spreadsheet_id")}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              spellCheck={false}
            />
          </FormField>
          <FormField label="Лист" tip={TIPS.sheetName}>
            <Input value={form.sheet_name} onChange={setText("sheet_name")} />
          </FormField>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
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

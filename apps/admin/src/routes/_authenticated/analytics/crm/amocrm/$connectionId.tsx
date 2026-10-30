import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Loader2, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import {
  AnalyticsAmoConnectionBodySkeleton,
  AnalyticsAmoConnectionPageSkeleton,
} from "@/components/page-skeletons";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { Button } from "@/components/ui/button";
import { CheckboxOption, FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
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
import {
  refreshAmoMetadata,
  replaceAmoToken,
  startAmoFullSync,
} from "@/lib/analytics/amo.functions";
import {
  amoConnectionQuery,
  amoRpc,
  invalidateAmo,
  type AmoConnectionView,
} from "@/lib/analytics/amo/data";
import { AMO_BRANDS, AMO_FIELD_KEYS, type AmoFieldKey } from "@/lib/analytics/amo/rules";

export const Route = createFileRoute("/_authenticated/analytics/crm/amocrm/$connectionId")({
  head: () => ({ meta: [{ title: "Настройка amoCRM — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsAmoConnectionPageSkeleton,
  component: AnalyticsAmoConnectionPage,
});

const FIELD_LABELS: Record<AmoFieldKey, { title: string; hint: string }> = {
  auto_source_field_id: {
    title: "Автоматический источник",
    hint: "Источник, проставляемый автоматически.",
  },
  manual_source_field_id: {
    title: "Источник администратора",
    hint: "Используется, если автоматический источник пуст.",
  },
  booked_field_id: {
    title: "Признак «Записан на пробное»",
    hint: "Ваш существующий триггер прохождения этапа.",
  },
  attended_field_id: {
    title: "Признак «Пришёл на пробное»",
    hint: "Ваш существующий триггер прохождения этапа.",
  },
  paid_field_id: { title: "Признак «Оплатил»", hint: "Ваш существующий триггер покупки." },
  close_basis_field_id: {
    title: "Поле «Основание для закрытия»",
    hint: "Обязательное поле: по его значениям определяется неквалифицированный лид.",
  },
};

const RUN_STATUS: Record<string, string> = {
  running: "идёт",
  success: "успешно",
  error: "ошибка",
};

/**
 * «Интеграция amoCRM» → подключение — их amocrm_settings_page: токен,
 * справочники (воронки, поля сделки, ответственные), ответственные →
 * города и партнёры, правила маркетинговой аналитики, квалификация лидов и
 * сбор сделок. Сохраняются технические ID — переименование в amoCRM
 * настройку не ломает.
 */
function AnalyticsAmoConnectionPage() {
  const id = Number(Route.useParams().connectionId);
  const { data, error, isPending } = useQuery(amoConnectionQuery(id));
  return (
    <AdminShell title={data?.connection.name ?? AN_TITLES.amoConnection}>
      <div className="max-w-5xl space-y-4">
        <Link
          to="/analytics/crm/amocrm"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> К подключениям amoCRM
        </Link>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : isPending || !data ? (
          <AnalyticsAmoConnectionBodySkeleton />
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{data.connection.base_url}</p>
            <TokenCard id={id} />
            <MetadataCard id={id} data={data} />
            <ResponsiblesCard id={id} data={data} />
            {data.metadata &&
              data.metadata.pipelines.length > 0 &&
              data.metadata.fields.length > 0 && (
                <SettingsCard key={JSON.stringify(data.settings)} id={id} data={data} />
              )}
            <BasisCard key={JSON.stringify(data.basis)} id={id} data={data} />
            <SyncCard id={id} data={data} />
          </>
        )}
      </div>
    </AdminShell>
  );
}

function Card({ title, text, children }: { title: string; text?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {text && <div className="space-y-1 text-sm text-muted-foreground">{text}</div>}
      </div>
      {children}
    </section>
  );
}

/** Общий обработчик кнопки: ход, тост, обновление данных. */
function useAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    try {
      const message = await fn();
      if (message) toast.success(message);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      await invalidateAmo(qc);
      setBusy(null);
    }
  };
  return { busy, run };
}

/** Их «Токен доступа AmoCRM». */
function TokenCard({ id }: { id: number }) {
  const [token, setToken] = useState("");
  const { busy, run } = useAction();
  return (
    <Card
      title="Токен доступа amoCRM"
      text="Используйте только для переподключения недоступного или истёкшего токена. Настройки воронки, соответствия городов и партнёров, а также уже собранные сделки сохранятся. Новый токен не будет показан или записан в журнал действий."
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run("token", async () => {
            const r = await replaceAmoToken({ data: { id, token } });
            setToken("");
            return r.message;
          });
        }}
      >
        <FormField label="Новый долгоживущий токен интеграции" required>
          <Input
            required
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Вставьте новый токен amoCRM"
          />
        </FormField>
        <Button type="submit" variant="outline" disabled={busy !== null}>
          {busy && <Loader2 className="animate-spin" />}
          Переподключить токен и проверить доступ
        </Button>
      </form>
    </Card>
  );
}

/** Их «Данные AmoCRM»: справочники без сделок и данных клиентов. */
function MetadataCard({ id, data }: { id: number; data: AmoConnectionView }) {
  const { busy, run } = useAction();
  const m = data.metadata;
  return (
    <Card
      title="Данные amoCRM"
      text={
        m
          ? `Загружено: ${m.pipelines.length} воронок, ${m.fields.length} полей и ${m.users.length} ответственных · ${formatMsk(m.fetched_at)}`
          : "Список воронок, полей и ответственных ещё не загружен."
      }
    >
      <div>
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void run("meta", async () => (await refreshAmoMetadata({ data: { id } })).message)
          }
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Обновить воронки и поля из amoCRM
        </Button>
      </div>
    </Card>
  );
}

/** Их «Ответственные AmoCRM → города и партнёры». */
function ResponsiblesCard({ id, data }: { id: number; data: AmoConnectionView }) {
  const { confirm, confirmDialog } = useConfirm();
  const { busy, run } = useAction();
  const users = data.metadata?.users ?? [];
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ user: "", brand: "Lady Stretch", city: "", partner: "" });

  const edit = (userId: string) => {
    const r = data.responsibles.find((x) => x.amo_user_id === userId);
    if (!r) return;
    setEditing(userId);
    setForm({ user: r.amo_user_id, brand: r.brand, city: r.city, partner: r.partner_name });
  };
  const reset = () => {
    setEditing(null);
    setForm({ user: "", brand: "Lady Stretch", city: "", partner: "" });
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run("save", async () => {
      await amoRpc.saveResponsible(id, form.user, form.brand, form.city, form.partner);
      reset();
      return "Соответствие ответственного сохранено.";
    });
  };
  const remove = async (userId: string) => {
    if (
      !(await confirm({
        title: "Удалить соответствие для этого ответственного?",
        confirmLabel: "Удалить",
      }))
    )
      return;
    void run(`del|${userId}`, async () => {
      await amoRpc.deleteResponsible(id, userId);
      if (editing === userId) reset();
      return "Соответствие удалено.";
    });
  };
  const clear = async () => {
    const ok = await confirm({
      title: "Очистить все соответствия ответственных?",
      description: "Собранные сделки не будут удалены.",
      confirmLabel: "Очистить",
    });
    if (!ok) return;
    void run("clear", async () => {
      const n = await amoRpc.clearResponsibles(id);
      reset();
      return `Соответствия очищены: ${n}. Настройте их заново и выполните полную сверку.`;
    });
  };

  return (
    <section className="rounded-lg border bg-background">
      {confirmDialog}
      <div className="space-y-3 border-b p-4">
        <div className="flex flex-wrap items-start justify-between gap-2 sm:flex-nowrap">
          <div className="min-w-0">
            <h2 className="font-semibold">Ответственные amoCRM → города и партнёры</h2>
            <p className="text-sm text-muted-foreground">
              Город сделки определяется по ответственному, а не по подключению amoCRM. Одна CRM
              может обслуживать любое число городов и партнёров.
            </p>
          </div>
          {data.responsibles.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              disabled={busy !== null}
              onClick={() => void clear()}
            >
              <Trash2 />
              Очистить все соответствия
            </Button>
          )}
        </div>
        {editing && (
          <InfoNote variant="info">
            Редактирование соответствия: внесите изменения и сохраните.
          </InfoNote>
        )}
        <form className="space-y-3" onSubmit={save}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Ответственный amoCRM" required>
              <SearchableCombobox
                value={form.user}
                onChange={(v) => setForm((f) => ({ ...f, user: v }))}
                options={users.map((u) => ({
                  value: u.id,
                  label: u.name || "Без имени",
                  searchText: `${u.name} ${u.id}`,
                }))}
                placeholder="Выберите ответственного amoCRM"
                searchPlaceholder="Ответственный"
                emptyText="Сначала обновите список ответственных из amoCRM"
              />
            </FormField>
            <FormField label="Направление" required>
              <SegmentedControl
                value={form.brand}
                onChange={(v) => setForm((f) => ({ ...f, brand: v }))}
                options={AMO_BRANDS.map((b) => ({ value: b, label: b }))}
                aria-label="Направление"
              />
            </FormField>
            <FormField label="Город" required>
              <Input
                required
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                placeholder="Город для отчёта"
              />
            </FormField>
            <FormField label="Партнёр" optional>
              <Input
                value={form.partner}
                onChange={(e) => setForm((f) => ({ ...f, partner: e.target.value }))}
                placeholder="Необязательно"
              />
            </FormField>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy !== null || !users.length}>
              {busy === "save" && <Loader2 className="animate-spin" />}
              {editing ? "Сохранить изменения" : "Сохранить соответствие"}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={reset}>
                <X />
                Отменить
              </Button>
            )}
          </div>
        </form>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ответственный</TableHead>
            <TableHead>Направление</TableHead>
            <TableHead>Город</TableHead>
            <TableHead>Партнёр</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.responsibles.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                Соответствий пока нет.
              </TableCell>
            </TableRow>
          ) : (
            data.responsibles.map((r) => (
              <TableRow key={r.amo_user_id}>
                <TableCell className="font-medium">{r.amo_user_name}</TableCell>
                <TableCell>{r.brand}</TableCell>
                <TableCell>{r.city}</TableCell>
                <TableCell>{r.partner_name || "—"}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Редактировать соответствие"
                    disabled={busy !== null}
                    onClick={() => edit(r.amo_user_id)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Удалить соответствие"
                    disabled={busy !== null}
                    onClick={() => void remove(r.amo_user_id)}
                  >
                    {busy === `del|${r.amo_user_id}` ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Trash2 />
                    )}
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

/** Их «Правила маркетинговой аналитики». */
function SettingsCard({ id, data }: { id: number; data: AmoConnectionView }) {
  const { busy, run } = useAction();
  const m = data.metadata!;
  const s = data.settings;
  const [brand, setBrand] = useState<string>(s?.brand ?? "Lady Stretch");
  const [pipeline, setPipeline] = useState(s?.new_lead_pipeline_id ?? "");
  const [fields, setFields] = useState<Record<AmoFieldKey, string>>(
    () =>
      Object.fromEntries(AMO_FIELD_KEYS.map((k) => [k, s?.[k] ?? ""])) as Record<
        AmoFieldKey,
        string
      >,
  );
  const fieldOptions = m.fields.map((f) => ({
    value: f.id,
    label: `${f.name || "Без названия"} · ID ${f.id}`,
    searchText: `${f.name} ${f.id}`,
  }));
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run("settings", async () => {
      await amoRpc.saveSettings(id, { brand, new_lead_pipeline_id: pipeline, ...fields });
      return "Настройки сохранены.";
    });
  };
  return (
    <Card
      title="Правила маркетинговой аналитики"
      text="Выберите только существующие поля сделки. Портал сохранит технические ID, поэтому переименование в amoCRM не нарушит настройку."
    >
      <form className="space-y-3" onSubmit={save}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Направление воронки" required>
            <SegmentedControl
              value={brand}
              onChange={setBrand}
              options={AMO_BRANDS.map((b) => ({ value: b, label: b }))}
              aria-label="Направление воронки"
            />
          </FormField>
          <FormField
            label="Воронка новых лидов"
            required
            hint="Только сделки, созданные в ней, позже войдут в отчёт."
          >
            <SearchableCombobox
              value={pipeline}
              onChange={setPipeline}
              options={m.pipelines
                .filter((p) => !p.is_archive)
                .map((p) => ({
                  value: p.id,
                  label: p.name || "Без названия",
                  searchText: `${p.name} ${p.id}`,
                }))}
              placeholder="Выберите воронку новых лидов"
              searchPlaceholder="Воронка"
              emptyText="Воронок нет"
            />
          </FormField>
          {AMO_FIELD_KEYS.map((k) => (
            <FormField key={k} label={FIELD_LABELS[k].title} required hint={FIELD_LABELS[k].hint}>
              <SearchableCombobox
                value={fields[k]}
                onChange={(v) => setFields((f) => ({ ...f, [k]: v }))}
                options={fieldOptions}
                placeholder="Выберите поле"
                searchPlaceholder="Поле сделки"
                emptyText="Полей нет"
              />
            </FormField>
          ))}
        </div>
        <Button type="submit" disabled={busy !== null}>
          {busy && <Loader2 className="animate-spin" />}
          Сохранить настройки
        </Button>
      </form>
    </Card>
  );
}

/** Их «Квалификация лидов»: значения «Основания для закрытия». */
function BasisCard({ id, data }: { id: number; data: AmoConnectionView }) {
  const { busy, run } = useAction();
  const values = data.basis.values;
  const [selected, setSelected] = useState(
    () => new Set(values.filter((v) => v.unqualified).map((v) => v.id)),
  );
  const toggle = (vid: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(vid);
      else next.delete(vid);
      return next;
    });
  return (
    <Card
      title="Квалификация лидов"
      text={
        <>
          <p>
            Отметьте значения поля «Основание для закрытия», при которых закрытый лид считается
            неквалифицированным — например, «мужчина» или «другой город». Встроенные причины
            закрытия amoCRM здесь не используются. Все остальные закрытые и активные сделки
            считаются квалифицированными.
          </p>
          <p>
            {data.basis.field_selected
              ? "Значения загружаются из пользовательского поля сделки amoCRM."
              : "Сначала в правилах выберите и сохраните поле «Основание для закрытия»."}
          </p>
        </>
      }
    >
      {values.length ? (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {values.map((v) => (
            <CheckboxOption
              key={v.id}
              checked={selected.has(v.id)}
              onCheckedChange={(on) => toggle(v.id, on)}
            >
              <span>
                <span className="font-medium">{v.value}</span>
                <span className="block text-xs text-muted-foreground">ID {v.id}</span>
              </span>
            </CheckboxOption>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Значения поля пока недоступны.</p>
      )}
      <Button
        disabled={busy !== null || !values.length}
        onClick={() =>
          void run("basis", async () => {
            await amoRpc.saveBasis(id, [...selected]);
            return "Правила квалификации сохранены.";
          })
        }
      >
        {busy && <Loader2 className="animate-spin" />}
        Сохранить квалификацию
      </Button>
    </Card>
  );
}

/** Их «Сбор сделок»: воронка, сколько собрано, последний сбор, полная сверка. */
function SyncCard({ id, data }: { id: number; data: AmoConnectionView }) {
  const { busy, run } = useAction();
  const pipeline = data.metadata?.pipelines.find(
    (p) => p.id === data.settings?.new_lead_pipeline_id,
  );
  const last = data.last_run;
  return (
    <Card
      title="Сбор сделок"
      text={
        <>
          <p>
            Воронка для сбора:{" "}
            <b className="text-foreground">
              {pipeline
                ? `${pipeline.name || "Без названия"} · ID ${pipeline.id}`
                : "Воронка не выбрана или требует обновления справочника."}
            </b>
            .
          </p>
          <p>
            Всего сохранено с 01.09.2026: <b className="text-foreground">{data.leads}</b> сделок.
          </p>
          <p>
            {last
              ? `Последнее обновление: ${formatMsk(last.started_at)} · ${RUN_STATUS[last.status] ?? last.status} · получено изменений ${last.received}, сохранено ${last.saved}` +
                (last.details ? ` · ${last.details}` : "")
              : "Сбор ещё не запускался."}
          </p>
          <p>
            Автоматический запуск раз в 15 минут берёт только изменения. Кнопка ниже всегда
            запускает полную сверку всех сделок с 01.09.2026. Контакты клиентов и персональные
            данные не сохраняются.
          </p>
        </>
      }
    >
      {!data.sync_enabled && (
        <InfoNote variant="warning">
          Задача «amoCRM: изменённые сделки» выключена на «Фоновых задачах» — сделки обновляются
          только кнопкой ниже.
        </InfoNote>
      )}
      <div>
        <Button
          disabled={busy !== null || !data.settings || data.running}
          onClick={() =>
            void run("sync", async () => (await startAmoFullSync({ data: { id } })).message)
          }
        >
          {(busy || data.running) && <Loader2 className="animate-spin" />}
          {data.running ? "Идёт сверка…" : "Полностью сверить сделки с amoCRM"}
        </Button>
      </div>
    </Card>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsVkAlertsPageSkeleton } from "@/components/page-skeletons";
import { SearchableCombobox } from "@/components/searchable-combobox";
import { TableSkeletonRows } from "@/components/skeletons";
import { Button } from "@/components/ui/button";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
import { pyFixed } from "@/lib/analytics/reviews/view";
import { BUDGET_STAGE_LABEL, type BudgetStage } from "@/lib/analytics/vk/budget";
import { invalidateVk, vkBudgetQuery, vkRpc } from "@/lib/analytics/vk/data";
import {
  bindPartnerChannel,
  saveTelegramSettings,
  sendTelegramTest,
  type VkBudgetPage,
} from "@/lib/analytics/vk-budget.functions";

export const Route = createFileRoute("/_authenticated/analytics/vk/alerts")({
  head: () => ({ meta: [{ title: "Контроль бюджетов — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsVkAlertsPageSkeleton,
  component: AnalyticsVkAlertsPage,
});

const STAGE_TONE: Record<BudgetStage, "warning" | "negative"> = {
  warning: "warning",
  critical: "negative",
  zero: "negative",
};

/**
 * «Аналитика» → «VK Ads» → «Контроль бюджетов» (администратору аналитики) —
 * их vk_ads_alerts_page: Telegram-бот (через Cloudflare-шлюз), чаты
 * партнёров, пороги и кабинеты, которым пора пополнить бюджет. Открытие
 * страницы пересчитывает предупреждения (как у них); отправка партнёрам —
 * задача «vk_budget_tg» после сбора VK Ads.
 */
function AnalyticsVkAlertsPage() {
  const { data, error, isPending } = useQuery(vkBudgetQuery);
  return (
    <AdminShell title={AN_TITLES.vkAlerts}>
      <div className="max-w-6xl space-y-4">
        <InfoNote>
          Прогноз строится по средним тратам за последние 7 полных дней. Рекомендованная сумма
          обеспечивает запас на {data?.settings.target_days ?? 7} дней.
        </InfoNote>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : (
          <>
            {data && !data.delivery_enabled && (
              <InfoNote variant="warning">
                Отправка предупреждений партнёрам выключена: старый портал аналитики шлёт их
                параллельно. Включите задачу «VK Ads: предупреждения о бюджете партнёрам в Telegram»
                на{" "}
                <Link
                  to="/analytics/admin/jobs"
                  className="font-medium underline underline-offset-2"
                >
                  «Фоновых задачах»
                </Link>
                , когда партнёры должны получать их отсюда. Предупреждения на этой странице
                считаются и без неё.
              </InfoNote>
            )}
            {data ? <TelegramCard data={data} /> : <Skeleton className="h-64 w-full rounded-lg" />}
            <Placeholders />
            {data ? (
              <PartnerChannelsCard data={data} />
            ) : (
              <Skeleton className="h-40 w-full rounded-lg" />
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <StatTile
                label="Предупреждение"
                loading={isPending}
                value={`≤ ${data?.settings.warning_days} дней`}
              />
              <StatTile
                label="Критический уровень"
                loading={isPending}
                value={`≤ ${data?.settings.critical_days} дня`}
              />
              <StatTile
                label="Целевой запас"
                loading={isPending}
                value={`${data?.settings.target_days} дней`}
              />
            </div>
            <AlertsCard data={data} loading={isPending} />
          </>
        )}
      </div>
    </AdminShell>
  );
}

function CardHead({ title, text, status }: { title: string; text: ReactNode; status: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 sm:flex-nowrap sm:gap-3">
      <div className="min-w-0">
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
      <div className="shrink-0">{status}</div>
    </div>
  );
}

/** Их «Telegram-бот»: токен и секреты — только «сохранён», значения не возвращаются. */
function TelegramCard({ data }: { data: VkBudgetPage }) {
  const qc = useQueryClient();
  const t = data.telegram;
  const gatewayConfigured = Boolean(t.gateway_url && t.gateway_secret_saved);
  const [form, setForm] = useState({
    botUsername: t.bot_username,
    token: "",
    gatewayUrl: t.gateway_url,
    gatewaySecret: "",
    testChatId: t.test_chat_id,
  });
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("save");
    try {
      const r = await saveTelegramSettings({ data: form });
      setForm((f) => ({ ...f, token: "", gatewaySecret: "" }));
      await invalidateVk(qc);
      toast.success(r.message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    try {
      const r = await sendTelegramTest({ data: { chatId: t.test_chat_id } });
      toast.success(r.message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      await invalidateVk(qc);
      setBusy(null);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-background p-4">
      <CardHead
        title="Telegram-бот"
        text="Токен и секреты сохраняются зашифрованно и больше не показываются."
        status={
          t.token_saved && gatewayConfigured ? (
            <StatusChip tone="positive">Подключён через шлюз</StatusChip>
          ) : (
            <StatusChip tone="warning">Нужно завершить настройку</StatusChip>
          )
        }
      />
      <form className="space-y-3" onSubmit={(e) => void save(e)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Username бота">
            <Input
              value={form.botUsername}
              onChange={set("botUsername")}
              placeholder="LadyStretch_BudgetBot"
            />
          </FormField>
          <FormField label="Токен Telegram">
            <Input
              type="password"
              autoComplete="new-password"
              value={form.token}
              onChange={set("token")}
              placeholder={
                t.token_saved ? "Токен сохранён — оставьте пустым" : "Вставьте токен из BotFather"
              }
            />
          </FormField>
          <FormField
            label="Адрес Cloudflare-шлюза"
            tip="С сервера в России Telegram может быть недоступен напрямую — сообщения идут через свой Worker Cloudflare (DEPLOY.md)."
          >
            <Input
              value={form.gatewayUrl}
              onChange={set("gatewayUrl")}
              placeholder="https://...workers.dev"
            />
          </FormField>
          <FormField label="Секрет Cloudflare-шлюза">
            <Input
              type="password"
              autoComplete="new-password"
              value={form.gatewaySecret}
              onChange={set("gatewaySecret")}
              placeholder={
                gatewayConfigured ? "Секрет сохранён — оставьте пустым" : "Вставьте GATEWAY_SECRET"
              }
            />
          </FormField>
          <FormField label="Тестовый чат" className="sm:col-span-2">
            <Input
              value={form.testChatId}
              onChange={set("testChatId")}
              placeholder="ID чата или выберите ниже"
            />
          </FormField>
        </div>
        <Button type="submit" disabled={busy !== null}>
          {busy === "save" && <Loader2 className="animate-spin" />}
          Сохранить подключение
        </Button>
      </form>
      <div className="space-y-2 border-t pt-3">
        <p className="text-sm">
          <b>Как выбрать чат.</b>{" "}
          <span className="text-muted-foreground">
            {data.chats.length
              ? `Найдено чатов: ${data.chats.length}. Выберите нужный или вставьте его ID.`
              : "После сохранения токена откройте чат с ботом и отправьте ему /start. Затем обновите эту страницу."}
          </span>
        </p>
        {data.chats.length > 0 && (
          <Select value="" onValueChange={(id) => setForm((f) => ({ ...f, testChatId: id }))}>
            <SelectTrigger className="w-full max-w-xl">
              <SelectValue placeholder="Выберите чат из найденных" />
            </SelectTrigger>
            <SelectContent>
              {data.chats.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.title} · {c.type} · ID {c.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {data.chat_error && <p className="text-sm text-destructive">{data.chat_error}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t pt-3">
        <Button
          variant="outline"
          disabled={busy !== null || !t.token_saved || !gatewayConfigured || !t.test_chat_id}
          onClick={() => void test()}
        >
          {busy === "test" ? <Loader2 className="animate-spin" /> : <Send />}
          Отправить тестовое сообщение
        </Button>
        {t.last_test_status && (
          <span className="text-sm text-muted-foreground">
            {t.last_test_status}
            {t.last_test_at && ` · ${formatMsk(t.last_test_at)}`}
          </span>
        )}
      </div>
    </section>
  );
}

/** Их сворачиваемые блоки MAX и Bitrix24 — пока не подключены. */
function Placeholders() {
  const items = [
    {
      title: "MAX",
      text: "Уведомления в MAX. Подключим после выбора способа авторизации и чатов партнёров.",
      chats: "Чаты партнёров в MAX: привязки появятся после подключения MAX.",
    },
    {
      title: "Bitrix24",
      text: "Уведомления и задачи в CRM. Подключим после определения сценария: уведомление в чат, задача или оба варианта.",
      chats: "Чаты партнёров в Bitrix24: привязки появятся после подключения Bitrix24.",
    },
  ];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {items.map((i) => (
        <section key={i.title} className="space-y-1 rounded-lg border bg-background p-4">
          <CardHead
            title={i.title}
            text={i.text}
            status={<StatusChip tone="neutral">Не подключён</StatusChip>}
          />
          <p className="text-xs text-muted-foreground">{i.chats}</p>
        </section>
      ))}
    </div>
  );
}

/** Их «Чаты партнёров в Telegram»: партнёр кабинетов → чат, который писал боту. */
function PartnerChannelsCard({ data }: { data: VkBudgetPage }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [partner, setPartner] = useState("");
  const [chat, setChat] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const bind = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("bind");
    try {
      const r = await bindPartnerChannel({ data: { partnerName: partner, chatId: chat } });
      setPartner("");
      setChat("");
      await invalidateVk(qc);
      toast.success(r.message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const remove = async (id: number) => {
    if (!(await confirm({ title: "Убрать привязку чата?", confirmLabel: "Убрать" }))) return;
    setBusy(`del|${id}`);
    try {
      await vkRpc.deletePartnerChannel(id);
      await invalidateVk(qc);
      toast.success("Привязка чата удалена.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-lg border bg-background">
      {confirmDialog}
      <div className="space-y-3 border-b p-4">
        <CardHead
          title="Чаты партнёров в Telegram"
          text="Привяжите чат к партнёру. Все его рекламные кабинеты будут определяться по полю «Партнёр»."
          status={
            data.channels.length ? (
              <StatusChip tone="positive">Подключения есть</StatusChip>
            ) : (
              <StatusChip tone="neutral">Нет подключений</StatusChip>
            )
          }
        />
        <form className="space-y-3" onSubmit={(e) => void bind(e)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Партнёр" required>
              <SearchableCombobox
                value={partner}
                onChange={setPartner}
                options={data.partners.map((p) => ({ value: p, label: p, searchText: p }))}
                placeholder="Найти партнёра"
                searchPlaceholder="Партнёр"
                emptyText="Сначала назначьте партнёра рекламному кабинету"
              />
            </FormField>
            <FormField label="Telegram-чат" required>
              <SearchableCombobox
                value={chat}
                onChange={setChat}
                options={data.chats.map((c) => ({
                  value: c.id,
                  label: c.title,
                  hint: `${c.type} · ID ${c.id}`,
                  searchText: `${c.title} ${c.type} ${c.id}`,
                }))}
                placeholder="Найти чат"
                searchPlaceholder="Чат"
                emptyText="Добавьте бота в чат и отправьте сообщение"
              />
            </FormField>
          </div>
          <Button
            type="submit"
            disabled={busy !== null || !data.partners.length || !data.chats.length}
          >
            {busy === "bind" && <Loader2 className="animate-spin" />}
            Привязать чат
          </Button>
        </form>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Партнёр</TableHead>
            <TableHead>Чат</TableHead>
            <TableHead>Статус</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.channels.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                Привязок пока нет.
              </TableCell>
            </TableRow>
          ) : (
            data.channels.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.partner_name}</TableCell>
                <TableCell>
                  {c.chat_title || "Telegram-чат"}
                  <div className="text-xs text-muted-foreground">ID {c.chat_id}</div>
                </TableCell>
                <TableCell>
                  <StatusChip size="sm" tone="positive">
                    Подключён
                  </StatusChip>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => void remove(c.id)}
                  >
                    {busy === `del|${c.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    Убрать
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

/** Их «Кабинеты, требующие внимания» (+ итог отправки партнёру, если была). */
function AlertsCard({ data, loading }: { data?: VkBudgetPage; loading: boolean }) {
  const alerts = data?.alerts ?? [];
  return (
    <section className="rounded-lg border bg-background">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-lg font-semibold">Кабинеты, требующие внимания</h2>
        <span className="text-xs text-muted-foreground">
          Новые предупреждения отправляются в привязанный чат партнёра
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Кабинет</TableHead>
            <TableHead>Уровень</TableHead>
            <TableHead>Остаток</TableHead>
            <TableHead>Средние траты/день</TableHead>
            <TableHead>Хватит на</TableHead>
            <TableHead>Рекомендуем пополнить</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableSkeletonRows columns={6} rows={5} />
          ) : alerts.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                Сейчас нет кабинетов, требующих пополнения.
              </TableCell>
            </TableRow>
          ) : (
            alerts.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <div className="font-medium">{a.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.city || "Город не назначен"}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusChip size="sm" tone={STAGE_TONE[a.stage]}>
                    {BUDGET_STAGE_LABEL[a.stage]}
                  </StatusChip>
                  {a.delivery && (
                    <div
                      className="mt-1 text-xs text-muted-foreground"
                      title={a.delivery.details || undefined}
                    >
                      {a.delivery.status === "sent"
                        ? "Отправлено партнёру"
                        : "Партнёру не отправлено"}
                    </div>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">{a.balance} ₽</TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {pyFixed(Number(a.average_daily_spend), 0)} ₽
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {pyFixed(Number(a.forecast_days), 1)} дн.
                </TableCell>
                <TableCell className="font-semibold whitespace-nowrap tabular-nums">
                  {a.recommended_topup} ₽
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

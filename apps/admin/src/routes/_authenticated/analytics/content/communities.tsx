import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsContentCommunitiesPageSkeleton } from "@/components/page-skeletons";
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
  CONTENT_KEY,
  contentCommunitiesQuery,
  contentRpc,
  type ContentCommunity,
} from "@/lib/analytics/content/data";
import {
  saveContentCommunity,
  saveContentMediaToken,
  testContentMediaUpload,
} from "@/lib/analytics/content.functions";
import { CONTENT_BRANDS, CONTENT_TIMEZONES, contentZoneLabel } from "@/lib/analytics/content/rules";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/content/communities")({
  head: () => ({ meta: [{ title: "Группы и ссылки — Контент — Lady Stretch" }] }),
  pendingComponent: AnalyticsContentCommunitiesPageSkeleton,
  component: AnalyticsContentCommunitiesPage,
});

const TEXT = {
  lead: "Одна запись — одно сообщество VK. Отключённые группы остаются в истории, но не попадают в новые посты.",
  media:
    "Для нативных фото VK требует пользовательский API-токен с правами photos, wall и groups. Он хранится на сервере зашифрованно и используется только для загрузки картинок; публикация идёт токеном каждой группы.",
  mediaOk:
    "Токен сохранён зашифрованно. Проверьте его на вашей тестовой группе: проверка получает только URL загрузки фото и не создаёт пост.",
};

/**
 * «Контент» → «Группы и ссылки» — их /admin/content/communities: группы VK
 * контент-плана (направление, город, часовой пояс, ссылки на пробное и
 * расписание, токен сообщества), технический токен для картинок и проверка.
 */
function AnalyticsContentCommunitiesPage() {
  const { data, error } = useQuery(contentCommunitiesQuery);
  const [adding, setAdding] = useState(false);
  return (
    <AdminShell
      title={AN_TITLES.contentCommunities}
      actions={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Добавить группу
        </Button>
      }
    >
      <div className="max-w-6xl space-y-5">
        <Button asChild variant="outline" size="sm">
          <Link to="/analytics/content">
            <ArrowLeft />
            Контент-план
          </Link>
        </Button>
        <InfoNote>{TEXT.lead}</InfoNote>
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? null : (
          <>
            <MediaCard hasToken={data.media_token} communities={data.communities} />
            <CommunitiesTable communities={data.communities} />
          </>
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-xl">
          {adding && <CommunityForm onClose={() => setAdding(false)} />}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function MediaCard({
  hasToken,
  communities,
}: {
  hasToken: boolean;
  communities: ContentCommunity[];
}) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [replace, setReplace] = useState(false);
  const [picked, setGroup] = useState("");
  // Их список: первая группа выбрана сразу (и когда группы появились позже).
  const group = picked || (communities[0] ? String(communities[0].id) : "");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<{ message: string }>) => {
    setBusy(true);
    try {
      toast.success((await action()).message);
      setToken("");
      setReplace(false);
      await qc.invalidateQueries({ queryKey: [...CONTENT_KEY] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tokenForm = (label: string) => (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => saveContentMediaToken({ data: { token } }));
      }}
    >
      <FormField
        label="Токен технического аккаунта VK"
        className="min-w-64 flex-1"
        htmlFor="content-media-token"
      >
        <Input
          id="content-media-token"
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </FormField>
      <Button type="submit" disabled={busy}>
        {busy && <Loader2 className="animate-spin" />}
        {label}
      </Button>
    </form>
  );
  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Техническое подключение VK для картинок</h2>
        {hasToken ? (
          <StatusChip tone="positive">VK подключён</StatusChip>
        ) : (
          <StatusChip tone="neutral">Не подключено</StatusChip>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{hasToken ? TEXT.mediaOk : TEXT.media}</p>
      {!hasToken ? (
        tokenForm("Сохранить и проверить подключение")
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="Тестовая группа" className="min-w-64">
              <Select value={group} onValueChange={setGroup}>
                <SelectTrigger aria-label="Тестовая группа">
                  <SelectValue placeholder="Выберите группу" />
                </SelectTrigger>
                <SelectContent>
                  {communities.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.display_name} · {c.city}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <Button
              disabled={busy || !communities.length}
              onClick={() =>
                void run(() =>
                  testContentMediaUpload({ data: { communityId: Number(group) || 0 } }),
                )
              }
            >
              {busy && <Loader2 className="animate-spin" />}
              Проверить загрузку картинки
            </Button>
            <Button variant="outline" onClick={() => setReplace((v) => !v)}>
              Заменить технический токен
            </Button>
          </div>
          {replace && tokenForm("Заменить токен")}
        </>
      )}
    </section>
  );
}

function CommunitiesTable({ communities }: { communities: ContentCommunity[] }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const act = async (action: () => Promise<unknown>, message: string) => {
    try {
      await action();
      toast.success(message);
      await qc.invalidateQueries({ queryKey: [...CONTENT_KEY] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Подключённые группы</h2>
        <span className="text-xs text-muted-foreground">Токены не отображаются в интерфейсе.</span>
      </div>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Группа</TableHead>
              <TableHead>Город / студия</TableHead>
              <TableHead>ID VK</TableHead>
              <TableHead>Часовой пояс</TableHead>
              <TableHead>Ссылка на пробное</TableHead>
              <TableHead>Ссылка на расписание</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {communities.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="min-w-44">
                  <div className="font-medium">{c.display_name}</div>
                  <div className="text-xs text-muted-foreground">{c.brand}</div>
                </TableCell>
                <TableCell>{c.city}</TableCell>
                <TableCell className="tabular-nums">{c.vk_community_id}</TableCell>
                <TableCell className="text-xs">{contentZoneLabel(c.timezone)}</TableCell>
                <TableCell className="max-w-48 truncate text-xs" title={c.trial_link}>
                  {c.trial_link || "—"}
                </TableCell>
                <TableCell className="max-w-48 truncate text-xs" title={c.schedule_link}>
                  {c.schedule_link || "—"}
                </TableCell>
                <TableCell>
                  <StatusChip tone={c.is_active ? "positive" : "neutral"}>
                    {c.is_active ? "Ведём" : "Не ведём"}
                  </StatusChip>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {c.has_token ? "Токен сохранён" : "Токен не добавлен"}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1.5 whitespace-nowrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        void act(
                          () => contentRpc("an_content_community_toggle", { p_id: c.id }),
                          "Статус группы изменён.",
                        )
                      }
                    >
                      {c.is_active ? "Отключить" : "Включить"}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8"
                      aria-label={`Удалить ${c.display_name}`}
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: `Удалить группу «${c.display_name}» безвозвратно?`,
                            confirmLabel: "Удалить",
                          }))
                        )
                          return;
                        void act(
                          () => contentRpc("an_content_community_delete", { p_id: c.id }),
                          "Группа удалена.",
                        );
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!communities.length && (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  Группы пока не добавлены.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {confirmDialog}
    </section>
  );
}

function CommunityForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [brand, setBrand] = useState<string>(CONTENT_BRANDS[0]);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [vk, setVk] = useState("");
  const [zone, setZone] = useState(CONTENT_TIMEZONES[0][0]);
  const [trial, setTrial] = useState("");
  const [schedule, setSchedule] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      const r = await saveContentCommunity({
        data: {
          brand,
          displayName: name,
          city,
          vkCommunity: vk,
          timezone: zone,
          trialLink: trial,
          scheduleLink: schedule,
          token,
        },
      });
      toast.success(r.message);
      await qc.invalidateQueries({ queryKey: [...CONTENT_KEY] });
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    extra: Partial<React.ComponentProps<typeof Input>> = {},
    required = false,
  ) => (
    <FormField label={label} htmlFor={id} required={required}>
      <Input id={id} value={value} onChange={(e) => set(e.target.value)} {...extra} />
    </FormField>
  );
  return (
    <>
      <DialogHeader>
        <DialogTitle>Добавить или обновить группу</DialogTitle>
        <DialogDescription>Повторный ID VK обновит существующую запись.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void submit()}>
        <DialogBody className="grid gap-4 sm:grid-cols-2">
          <FormField label="Направление" required>
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger aria-label="Направление">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_BRANDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {field(
            "content-name",
            "Название группы",
            name,
            setName,
            { placeholder: "Lady Stretch Тула" },
            true,
          )}
          {field("content-city", "Город или студия", city, setCity, { placeholder: "Тула" }, true)}
          {field(
            "content-vk",
            "ID или ссылка на группу VK",
            vk,
            setVk,
            { placeholder: "123456789 или vk.ru/public123456789" },
            true,
          )}
          <FormField label="Часовой пояс" required className="sm:col-span-2">
            <Select value={zone} onValueChange={setZone}>
              <SelectTrigger aria-label="Часовой пояс">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTENT_TIMEZONES.map(([z, label]) => (
                  <SelectItem key={z} value={z}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          {field("content-trial", "Ссылка на пробное", trial, setTrial, {
            placeholder: "https://vk.cc/...",
            autoComplete: "off",
          })}
          {field("content-schedule", "Ссылка на расписание", schedule, setSchedule, {
            placeholder: "https://vk.cc/...",
            autoComplete: "off",
          })}
          <div className="sm:col-span-2">
            {field("content-token", "Токен сообщества VK", token, setToken, {
              type: "password",
              autoComplete: "new-password",
              placeholder: "Сохраняется зашифрованно и не показывается повторно",
            })}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить группу
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

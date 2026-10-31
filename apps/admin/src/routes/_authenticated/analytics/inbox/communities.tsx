import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Copy, KeyRound, Loader2, Pencil, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { AnalyticsInboxCommunitiesPageSkeleton } from "@/components/page-skeletons";
import { TableToolbar } from "@/components/table-toolbar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { SearchInput } from "@/components/ui/search-input";
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
import { formatMsk } from "@/lib/analytics/core";
import {
  INBOX_KEY,
  inboxCommunitiesQuery,
  inboxRpc,
  type InboxCommunities,
  type InboxCommunity,
  type InboxPerson,
} from "@/lib/analytics/inbox/data";
import { registerInboxCommunity, syncInboxSecret } from "@/lib/analytics/inbox.functions";
import { INBOX_BRANDS, inboxCallbackUrl } from "@/lib/analytics/inbox/rules";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/inbox/communities")({
  head: () => ({ meta: [{ title: "Подключения сообществ — Диалоги VK — Lady Stretch" }] }),
  pendingComponent: AnalyticsInboxCommunitiesPageSkeleton,
  component: AnalyticsInboxCommunitiesPage,
});

const TEXT = {
  lead: "Самостоятельный контур: добавьте группу, город, направление и токен сообщений прямо здесь. Сообщения портал получает сам — своим сервером Callback API в каждой группе; сервер старого портала в группе остаётся (у сообщества их может быть несколько).",
  howTo:
    "Сначала откройте в VK: «Управление» → «Работа с API» → Callback API → «Добавить сервер». Скопируйте group_id и «Строку, которую должен вернуть сервер», затем заполните форму. После сохранения портал выдаст URL и секрет для вставки обратно в VK.",
  once: "Секрет показывается только один раз и не сохраняется открыто. В Callback API сообщества VK вставьте URL и секрет ниже, сохраните секрет, затем нажмите «Подтвердить» для URL. В «Типах событий» включите «Входящее сообщение», «Исходящее сообщение» и «Редактирование сообщения».",
  managers:
    "Лид-менеджер видит и отвечает только в выбранных сообществах. Роль «Лид-менеджер» (право «Лид-менеджер: диалоги VK») выдаётся в «Пользователях и ролях», сообщества — здесь. Администратору аналитики открыты все сообщества.",
  token: "Создайте отдельный токен сообщества VK с разрешением «Сообщения сообщества».",
};

const copy = (value: string, what: string) => {
  void navigator.clipboard.writeText(value);
  toast.success(`${what} скопирован.`);
};

const callbackUrl = (id: number) =>
  inboxCallbackUrl(typeof window === "undefined" ? "" : window.location.origin, id);

type Setup = { id: number; secret: string; name: string };

/**
 * «Диалоги VK» → «Подключения» (администратору аналитики) — их
 * /admin/vk-inbox/communities и «Доступ к VK Inbox» лид-менеджеров
 * (/admin/users/<id>/inbox-access): группы с токеном сообщений и Callback
 * API, направление и город, код подтверждения и секрет, сообщества
 * лид-менеджеров.
 */
function AnalyticsInboxCommunitiesPage() {
  const { data, error } = useQuery(inboxCommunitiesQuery);
  const [adding, setAdding] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  return (
    <AdminShell
      title={AN_TITLES.inboxCommunities}
      actions={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Подключить группу
        </Button>
      }
    >
      <div className="max-w-6xl space-y-6">
        <InfoNote>{TEXT.lead}</InfoNote>
        {setup && <SetupCard setup={setup} onHide={() => setSetup(null)} />}
        {error ? (
          <InfoNote variant="warning">{(error as Error).message}</InfoNote>
        ) : !data ? null : (
          <>
            <CommunitiesCard data={data} />
            <ManagersCard data={data} />
          </>
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-xl">
          {adding && (
            <RegisterForm
              onClose={() => setAdding(false)}
              onDone={(s) => {
                setAdding(false);
                setSetup(s);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

function SetupCard({ setup, onHide }: { setup: Setup; onHide: () => void }) {
  const url = callbackUrl(setup.id);
  return (
    <section className="space-y-3 rounded-lg border border-emerald-200 bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Подключение создано — настройте VK</h2>
        <StatusChip tone="positive">Данные готовы</StatusChip>
      </div>
      <p className="text-sm text-muted-foreground">{TEXT.once}</p>
      <FormField label="URL Callback API">
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono text-xs" />
          <Button
            variant="outline"
            size="icon"
            aria-label="Скопировать URL"
            onClick={() => copy(url, "URL")}
          >
            <Copy />
          </Button>
        </div>
      </FormField>
      <FormField label="Секрет Callback API">
        <div className="flex gap-2">
          <Input readOnly value={setup.secret} className="font-mono text-xs" />
          <Button
            variant="outline"
            size="icon"
            aria-label="Скопировать секрет"
            onClick={() => copy(setup.secret, "Секрет")}
          >
            <Copy />
          </Button>
        </div>
      </FormField>
      <Button variant="outline" size="sm" onClick={onHide}>
        Готово, скрыть секрет
      </Button>
    </section>
  );
}

function RegisterForm({ onClose, onDone }: { onClose: () => void; onDone: (s: Setup) => void }) {
  const qc = useQueryClient();
  const [brand, setBrand] = useState<string>(INBOX_BRANDS[0]);
  const [city, setCity] = useState("");
  const [name, setName] = useState("");
  const [vkId, setVkId] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true);
    try {
      const r = await registerInboxCommunity({
        data: {
          brand,
          city,
          displayName: name,
          vkCommunity: vkId,
          confirmationCode: code,
          token,
        },
      });
      await qc.invalidateQueries({ queryKey: [...INBOX_KEY] });
      toast.success(r.message);
      onDone({ id: r.id, secret: r.secret, name: r.displayName });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Подключить группу к диалогам</DialogTitle>
        <DialogDescription>{TEXT.howTo}</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void submit()}>
        <DialogBody className="grid gap-4 sm:grid-cols-2">
          <FormField label="Направление" required>
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger aria-label="Направление">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INBOX_BRANDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Город" required htmlFor="inbox-city">
            <Input
              id="inbox-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Например, Тула"
            />
          </FormField>
          <FormField
            label="Название группы"
            required
            htmlFor="inbox-name"
            tip="Если VK вернёт по ссылке другое название группы, сохранится название из VK."
          >
            <Input
              id="inbox-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Lady Stretch Тула"
            />
          </FormField>
          <FormField
            label="group_id из VK"
            required
            htmlFor="inbox-vk"
            tip="Число из Callback API или ссылка на группу: vk.ru/public123456 или короткий адрес vk.ru/ladystretch_penza — его портал проверит в VK."
          >
            <Input
              id="inbox-vk"
              value={vkId}
              onChange={(e) => setVkId(e.target.value)}
              placeholder="Например, 216469945"
            />
          </FormField>
          <FormField
            label="Строка подтверждения из VK Callback API"
            required
            htmlFor="inbox-code"
            className="sm:col-span-2"
          >
            <Input
              id="inbox-code"
              value={code}
              autoComplete="off"
              onChange={(e) => setCode(e.target.value)}
              placeholder="Например, e16b9eb3"
            />
          </FormField>
          <FormField
            label="Токен сообщества с правом сообщений"
            required
            htmlFor="inbox-token"
            hint={TEXT.token}
            className="sm:col-span-2"
          >
            <Input
              id="inbox-token"
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Сохраняется зашифрованно и не показывается повторно"
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить группу и получить Callback-данные
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

type Edit = { kind: "details" | "code" | "secret"; c: InboxCommunity };

function CommunitiesCard({ data }: { data: InboxCommunities }) {
  const [edit, setEdit] = useState<Edit | null>(null);
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Подключённые сообщества</h2>
        <span className="text-xs text-muted-foreground">Секреты и токены не отображаются.</span>
      </div>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Группа</TableHead>
              <TableHead>ID VK</TableHead>
              <TableHead>Callback API</TableHead>
              <TableHead>Подключено</TableHead>
              <TableHead className="text-right">Диалогов</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.communities.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="min-w-56">
                  <div className="font-medium">{c.display_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.brand} · {c.city}
                  </div>
                </TableCell>
                <TableCell className="tabular-nums">{c.vk_community_id}</TableCell>
                <TableCell>
                  {c.last_verified_at ? (
                    <StatusChip tone="positive">Подтверждено</StatusChip>
                  ) : (
                    <StatusChip tone="warning">Ожидает настройки VK</StatusChip>
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatMsk(c.connected_at)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.dialogs}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-1.5 md:flex-nowrap md:whitespace-nowrap">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEdit({ kind: "details", c })}
                    >
                      <Pencil />
                      Изменить
                    </Button>
                    {!c.last_verified_at && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEdit({ kind: "code", c })}
                      >
                        <ShieldCheck />
                        Код VK
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEdit({ kind: "secret", c })}
                    >
                      <KeyRound />
                      Секрет
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-8"
                      aria-label="Скопировать URL Callback API"
                      onClick={() => copy(callbackUrl(c.id), "URL Callback API")}
                    >
                      <Copy />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!data.communities.length && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                  Сообщества для диалогов ещё не подключены.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="sm:max-w-md">
          {edit?.kind === "details" && (
            <DetailsForm key={edit.c.id} c={edit.c} onClose={() => setEdit(null)} />
          )}
          {edit?.kind === "code" && (
            <CodeForm key={edit.c.id} c={edit.c} onClose={() => setEdit(null)} />
          )}
          {edit?.kind === "secret" && (
            <SecretForm key={edit.c.id} c={edit.c} onClose={() => setEdit(null)} />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/** Общая форма окна: сохранение, тост, обновление списка. */
function useSave(onClose: () => void) {
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const run = async (action: () => Promise<string>) => {
    setSaving(true);
    try {
      const message = await action();
      await qc.invalidateQueries({ queryKey: [...INBOX_KEY] });
      toast.success(message);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return { saving, run };
}

function FormButtons({
  saving,
  onClose,
  label,
}: {
  saving: boolean;
  onClose: () => void;
  label: string;
}) {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onClose} disabled={saving}>
        Отмена
      </Button>
      <Button type="submit" disabled={saving}>
        {saving && <Loader2 className="animate-spin" />}
        {label}
      </Button>
    </DialogFooter>
  );
}

function DetailsForm({ c, onClose }: { c: InboxCommunity; onClose: () => void }) {
  const [brand, setBrand] = useState(c.brand);
  const [city, setCity] = useState(c.city);
  const { saving, run } = useSave(onClose);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{c.display_name}</DialogTitle>
        <DialogDescription>
          Меняются только подписи: токен, ID группы и вся история диалогов остаются.
        </DialogDescription>
      </DialogHeader>
      <DialogForm
        onSubmit={() =>
          void run(async () => {
            await inboxRpc("an_inbox_community_update", {
              p_id: c.id,
              p_brand: brand,
              p_city: city,
            });
            return "Направление и город сохранены.";
          })
        }
      >
        <DialogBody className="space-y-4">
          <FormField label="Направление" required>
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger aria-label="Направление">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INBOX_BRANDS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Город" required htmlFor="inbox-edit-city">
            <Input
              id="inbox-edit-city"
              value={city}
              maxLength={200}
              onChange={(e) => setCity(e.target.value)}
            />
          </FormField>
        </DialogBody>
        <FormButtons saving={saving} onClose={onClose} label="Сохранить" />
      </DialogForm>
    </>
  );
}

function CodeForm({ c, onClose }: { c: InboxCommunity; onClose: () => void }) {
  const [code, setCode] = useState("");
  const { saving, run } = useSave(onClose);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Код подтверждения VK</DialogTitle>
        <DialogDescription>
          {c.display_name}: строка, которую VK показывает в Callback API («Строка, которую должен
          вернуть сервер»).
        </DialogDescription>
      </DialogHeader>
      <DialogForm
        onSubmit={() =>
          void run(async () => {
            await inboxRpc("an_inbox_confirmation_save", { p_id: c.id, p_code: code });
            return "Код подтверждения VK сохранён. Вернитесь в VK и нажмите «Подтвердить» ещё раз.";
          })
        }
      >
        <DialogBody>
          <FormField label="Код VK" required htmlFor="inbox-code-edit">
            <Input
              id="inbox-code-edit"
              value={code}
              autoComplete="off"
              onChange={(e) => setCode(e.target.value)}
            />
          </FormField>
        </DialogBody>
        <FormButtons saving={saving} onClose={onClose} label="Сохранить" />
      </DialogForm>
    </>
  );
}

function SecretForm({ c, onClose }: { c: InboxCommunity; onClose: () => void }) {
  const [secret, setSecret] = useState("");
  const { saving, run } = useSave(onClose);
  return (
    <>
      <DialogHeader>
        <DialogTitle>Секрет Callback API</DialogTitle>
        <DialogDescription>
          {c.display_name}: если секрет в настройках сервера VK изменили, вставьте текущий — портал
          сохранит только его отпечаток.
        </DialogDescription>
      </DialogHeader>
      <DialogForm
        onSubmit={() =>
          void run(async () => (await syncInboxSecret({ data: { id: c.id, secret } })).message)
        }
      >
        <DialogBody>
          <FormField label="Секрет из VK" required htmlFor="inbox-secret">
            <Input
              id="inbox-secret"
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </FormField>
        </DialogBody>
        <FormButtons saving={saving} onClose={onClose} label="Синхронизировать" />
      </DialogForm>
    </>
  );
}

function ManagersCard({ data }: { data: InboxCommunities }) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<InboxPerson | null>(null);
  const names = useMemo(() => new Map(data.communities.map((c) => [c.id, c])), [data]);
  const q = query.trim().toLocaleLowerCase("ru");
  const people = data.people.filter(
    (p) =>
      !q ||
      p.full_name.toLocaleLowerCase("ru").includes(q) ||
      (p.email ?? "").toLocaleLowerCase("ru").includes(q),
  );
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Доступ лид-менеджеров</h2>
      <InfoNote>{TEXT.managers}</InfoNote>
      <TableToolbar>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="Имя или почта"
          aria-label="Поиск лид-менеджера"
        />
      </TableToolbar>
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Сотрудник</TableHead>
              <TableHead>Сообщества VK</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((p) => (
              <TableRow key={p.user_id}>
                <TableCell className="min-w-48">
                  <div className="font-medium">{p.full_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[p.position, p.email].filter(Boolean).join(" · ")}
                  </div>
                </TableCell>
                <TableCell>
                  {p.admin ? (
                    <StatusChip tone="info">Все сообщества — администратор аналитики</StatusChip>
                  ) : p.communities.length ? (
                    <span className="text-sm">
                      {p.communities
                        .map((id) => names.get(id))
                        .filter(Boolean)
                        .map((c) => `${c!.display_name} · ${c!.city}`)
                        .join(", ")}
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">Нет сообществ</span>
                  )}
                  {!p.admin && (!p.manager || !p.active) && (
                    <StatusChip tone="warning" className="ml-2">
                      {!p.manager ? "Нет роли «Лид-менеджер»" : "Учётная запись выключена"}
                    </StatusChip>
                  )}
                </TableCell>
                <TableCell>
                  {!p.admin && (
                    <Button variant="outline" size="sm" onClick={() => setEditing(p)}>
                      Сообщества
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!people.length && (
              <TableRow>
                <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                  {q
                    ? "Никого не нашлось"
                    : "Лид-менеджеров пока нет: выдайте роль «Лид-менеджер» в «Пользователях и ролях»."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          {editing && (
            <AccessForm
              key={editing.user_id}
              person={editing}
              data={data}
              onClose={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

const codeSort = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function AccessForm({
  person,
  data,
  onClose,
}: {
  person: InboxPerson;
  data: InboxCommunities;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState(() => new Set(person.communities));
  const { saving, run } = useSave(onClose);
  const groups = useMemo(() => {
    const m = new Map<string, InboxCommunity[]>();
    for (const c of data.communities.filter((x) => x.is_active)) {
      const key = `${c.brand} · ${c.city}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(c);
    }
    return [...m].sort(([a], [b]) => codeSort(a, b));
  }, [data]);
  const toggle = (id: number, on: boolean) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{person.full_name}</DialogTitle>
        <DialogDescription>
          Менеджер увидит и сможет отвечать только в выбранных сообществах. Снимите все галочки,
          чтобы закрыть доступ.
        </DialogDescription>
      </DialogHeader>
      <DialogForm
        onSubmit={() =>
          void run(async () => {
            await inboxRpc("an_inbox_access_save", {
              p_user: person.user_id,
              p_ids: [...picked].sort((a, b) => a - b),
            });
            return "Доступ к чатам сохранён.";
          })
        }
      >
        <DialogBody className="space-y-4">
          {groups.map(([label, list]) => (
            <div key={label} className="space-y-1">
              <p className="text-sm font-semibold">{label}</p>
              {list.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={picked.has(c.id)}
                    onCheckedChange={(v) => toggle(c.id, v === true)}
                  />
                  <span>{c.display_name}</span>
                </label>
              ))}
            </div>
          ))}
          {!groups.length && <InfoNote>Нет активных сообществ VK.</InfoNote>}
        </DialogBody>
        <FormButtons saving={saving} onClose={onClose} label="Сохранить доступ к чатам" />
      </DialogForm>
    </>
  );
}

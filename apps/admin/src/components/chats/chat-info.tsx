/**
 * Сведения о чате — шторка справа (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 3.5):
 * уведомления чата «Все / Упоминания / Без звука» со ссылкой на все
 * уведомления портала, «Закрепить чат», «Скопировать ссылку на чат»;
 * у администраторов группы — карандаш у названия (окно «Изменить группу») и
 * «Что могут участники» — переключатели, применяются сразу; «Кто в чате
 * автоматически»; вкладки «Участники / Медиа / Файлы / Ссылки» (у участника —
 * «⋯»: написать, администратор, убрать); выход и удаление группы.
 */
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Link2,
  Loader2,
  LogOut,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
} from "lucide-react";
import { toast } from "sonner";

import { ChatContextMenu, ChatMoreMenu, type ChatMenuItem } from "@/components/chats/action-menu";
import { FileCard } from "@/components/chats/attachments";
import { ChatAvatar } from "@/components/chats/chat-avatar";
import { ChatSourcesBlock } from "@/components/chats/chat-sources";
import { AddMembersDialog } from "@/components/chats/dialogs";
import { VoicePlayer } from "@/components/chats/voice-player";
import { useConfirm } from "@/components/confirm-dialog";
import { StaffAvatar } from "@/components/employee-photo";
import { PersonButton } from "@/components/people/person-card";
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
import { FormField, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusChip } from "@/components/ui/status-chip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  chatTitle,
  dayLabel,
  isImage,
  mutedUntil,
  notifyChoice,
  untilLabel,
} from "@/lib/chats/content";
import {
  chatErrorText,
  chatMembersQuery,
  chatRpc,
  openDirect,
  setTopicsEnabled,
  useChatList,
} from "@/lib/chats/data";
import { useChatFileUrl } from "@/lib/chats/files";
import { applyNotify } from "@/lib/chats/mute-menu";
import { usePeople } from "@/lib/chats/people";
import type { ChatAttachment, ChatMember, ChatNotify, ChatRow } from "@/lib/chats/types";
import { isVoice } from "@/lib/chats/voice";
import { lastSeenLabel } from "@/lib/company";

type Tab = "members" | "media" | "files" | "links";

const ROLE_LABEL = { owner: "Владелец", admin: "Администратор", member: "" } as const;

const capital = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

export function ChatInfo({
  chat,
  topic = null,
  me,
  open,
  onClose,
  onJump,
}: {
  chat: ChatRow;
  /** Открыта тема группы: сведения — группы, с подписью темы (3.5.7). */
  topic?: ChatRow | null;
  me: string;
  open: boolean;
  onClose: () => void;
  onJump: (seq: number) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { name, person } = usePeople();
  const { confirm, confirmDialog } = useConfirm();
  const [tab, setTab] = useState<Tab>(chat.kind === "group" ? "members" : "media");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);
  const title = chatTitle(chat, name);
  const members = useQuery({ ...chatMembersQuery(chat.id), enabled: open });
  const isAdmin = chat.my_role !== "member";
  const isGroup = chat.kind === "group";
  const channel = !!chat.settings?.channel;
  const noun = channel ? "канал" : "группу";
  const myAuto = (members.data ?? []).some((m) => m.user_id === me && m.source === "auto");

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["chat_list"] }),
      qc.invalidateQueries({ queryKey: ["chat_members", chat.id] }),
    ]);

  const call = async (fn: string, args: Record<string, unknown>, ok?: string) => {
    try {
      await chatRpc(fn, args);
      await refresh();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  const leave = async () => {
    const ok = await confirm({
      title: channel ? "Выйти из канала?" : "Выйти из группы?",
      description: "Вернуться можно, только если вас добавят снова.",
      confirmLabel: "Выйти",
    });
    if (!ok) return;
    await call("chat_member_remove", { p_chat: chat.id, p_user: me });
    onClose();
    navigate({ to: "/chats" });
  };

  const removeGroup = async () => {
    const ok = await confirm({
      title: `Удалить ${noun}?`,
      description: "Переписка и файлы пропадут у всех участников. Вернуть нельзя.",
      confirmLabel: `Удалить ${noun}`,
    });
    if (!ok) return;
    await call(
      "chat_delete_group",
      { p_chat: chat.id },
      channel ? "Канал удалён" : "Группа удалена",
    );
    onClose();
    navigate({ to: "/chats" });
  };

  const writeTo = async (userId: string) => {
    try {
      const id = await openDirect(userId);
      await qc.invalidateQueries({ queryKey: ["chat_list"] });
      onClose();
      navigate({ to: "/chats/$chatId", params: { chatId: id } });
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };

  const memberMenu = (m: ChatMember): ChatMenuItem[] => {
    const items: ChatMenuItem[] = [];
    if (m.user_id !== me)
      items.push({
        label: "Написать",
        icon: MessageSquare,
        onSelect: () => void writeTo(m.user_id),
      });
    if (isGroup && chat.my_role === "owner" && m.role !== "owner")
      items.push(
        m.role === "admin"
          ? {
              label: "Снять права администратора",
              icon: Shield,
              onSelect: () =>
                void call(
                  "chat_member_set_role",
                  { p_chat: chat.id, p_user: m.user_id, p_role: "member" },
                  `${name(m.user_id)} — больше не администратор`,
                ),
            }
          : {
              label: "Сделать администратором",
              icon: Shield,
              onSelect: () =>
                void call(
                  "chat_member_set_role",
                  { p_chat: chat.id, p_user: m.user_id, p_role: "admin" },
                  `${name(m.user_id)} — теперь администратор`,
                ),
            },
      );
    if (
      isGroup &&
      m.user_id !== me &&
      m.role !== "owner" &&
      m.source !== "auto" &&
      (chat.my_role === "owner" || (chat.my_role === "admin" && m.role === "member"))
    )
      items.push({
        label: channel ? "Убрать из канала" : "Убрать из группы",
        icon: UserMinus,
        destructive: true,
        separatorBefore: items.length > 0,
        onSelect: () =>
          void (async () => {
            const ok = await confirm({
              title: `Убрать ${name(m.user_id)} из ${channel ? "канала" : "группы"}?`,
              description: "Добавить снова можно в любой момент.",
              confirmLabel: "Убрать",
            });
            if (ok)
              await call(
                "chat_member_remove",
                { p_chat: chat.id, p_user: m.user_id },
                `${name(m.user_id)} — убран(а) из ${channel ? "канала" : "группы"}`,
              );
          })(),
      });
    return items;
  };

  const until = mutedUntil(chat);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="items-center gap-2 border-b p-6 text-center">
          <ChatAvatar chat={chat} title={title} />
          <div className="flex max-w-full items-center justify-center gap-1">
            <SheetTitle className="min-w-0 truncate text-center">{title}</SheetTitle>
            {isGroup && isAdmin && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={channel ? "Изменить канал" : "Изменить группу"}
                title={channel ? "Изменить канал" : "Изменить группу"}
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-4" />
              </Button>
            )}
          </div>
          <SheetDescription className="text-center">
            {topic
              ? `Группа «${title}» (тема «${topic.title ?? "Тема"}»)`
              : chat.kind === "direct"
                ? [
                    person(chat.peer_id)?.position_name,
                    lastSeenLabel(person(chat.peer_id)?.last_seen_at ?? null),
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : chat.kind === "self"
                  ? "Заметки и пересланное для себя"
                  : chat.description || `Участников: ${chat.member_count}`}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 border-b p-4">
          {chat.kind !== "self" && (
            <FormField
              label="Уведомления"
              htmlFor={null}
              hint={
                <>
                  {until
                    ? `Сейчас без звука ${untilLabel(until)}. `
                    : "Без звука: счётчик серым, в общем числе не считается. "}
                  <Link
                    to="/notifications/settings"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    Все уведомления портала
                    <ArrowRight className="ml-0.5 inline size-3" />
                  </Link>
                </>
              }
            >
              <SegmentedControl<ChatNotify>
                aria-label="Уведомления чата"
                fullWidth
                value={notifyChoice(chat)}
                onChange={(v) => applyNotify(qc, chat, v, null)}
                options={[
                  { value: "all", label: "Все" },
                  { value: "mentions", label: "Упоминания", title: "Только упоминания и ответы" },
                  { value: "none", label: "Без звука" },
                ]}
              />
            </FormField>
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              void call(
                "chat_set_pinned",
                { p_chat: chat.id, p_on: !chat.pinned_at },
                chat.pinned_at ? "Чат откреплён" : "Чат закреплён наверху списка",
              )
            }
          >
            {chat.pinned_at ? <PinOff /> : <Pin />}
            {chat.pinned_at ? "Открепить чат" : "Закрепить чат"}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() =>
              void navigator.clipboard
                .writeText(`${window.location.origin}/chats/${chat.id}`)
                .then(() => toast.success("Ссылка на чат скопирована"))
            }
          >
            <Link2 /> Скопировать ссылку на чат
          </Button>
        </div>

        {isGroup && isAdmin && <GroupPermissions chat={chat} onSaved={refresh} />}
        {isGroup && <ChatSourcesBlock chat={chat} open={open} />}

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="flex flex-1 flex-col p-4"
        >
          <TabsList className="w-full">
            {chat.kind !== "self" && (
              <TabsTrigger value="members" className="flex-1">
                Участники
              </TabsTrigger>
            )}
            <TabsTrigger value="media" className="flex-1">
              Медиа
            </TabsTrigger>
            <TabsTrigger value="files" className="flex-1">
              Файлы
            </TabsTrigger>
            <TabsTrigger value="links" className="flex-1">
              Ссылки
            </TabsTrigger>
          </TabsList>
          <TabsContent value="members" className="mt-4 space-y-1">
            {isGroup && (isAdmin || chat.settings?.add === "all") && (
              <Button variant="outline" className="mb-2 w-full" onClick={() => setAdding(true)}>
                <UserPlus /> Добавить участников
              </Button>
            )}
            {members.isPending ? (
              <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
            ) : (
              (members.data ?? []).map((m) => {
                const items = memberMenu(m);
                return (
                  <ChatContextMenu key={m.user_id} items={items}>
                    <div className="group/row flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50">
                      <PersonButton
                        userId={m.user_id}
                        className="flex min-w-0 flex-1 items-center gap-3"
                      >
                        <StaffAvatar
                          value={person(m.user_id)?.avatar_url}
                          name={name(m.user_id)}
                          className="size-9 text-xs"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {name(m.user_id)}
                            {m.user_id === me && (
                              <span className="text-muted-foreground"> · вы</span>
                            )}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {[
                              m.source === "auto" ? "в чате автоматически" : null,
                              lastSeenLabel(person(m.user_id)?.last_seen_at ?? null),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                      </PersonButton>
                      {ROLE_LABEL[m.role] && (
                        <StatusChip tone="strong" size="sm">
                          {ROLE_LABEL[m.role]}
                        </StatusChip>
                      )}
                      <ChatMoreMenu
                        items={items}
                        label={`Действия: ${name(m.user_id)}`}
                        reveal="row"
                      />
                    </div>
                  </ChatContextMenu>
                );
              })
            )}
          </TabsContent>
          <TabsContent value="media" className="mt-4">
            <FilesTab chatId={chat.id} kind="media" onJump={onJump} />
          </TabsContent>
          <TabsContent value="files" className="mt-4">
            <FilesTab chatId={chat.id} kind="files" onJump={onJump} />
          </TabsContent>
          <TabsContent value="links" className="mt-4">
            <LinksTab chatId={chat.id} onJump={onJump} />
          </TabsContent>
        </Tabs>

        {isGroup && (
          <div className="space-y-2 border-t p-4">
            {myAuto ? (
              <p className="text-xs text-muted-foreground">
                Вы в чате автоматически — по подразделению. Выйти нельзя, но можно выключить
                уведомления выше.
              </p>
            ) : (
              <Button
                variant="outline"
                className="w-full text-destructive"
                onClick={() => void leave()}
              >
                <LogOut /> {channel ? "Выйти из канала" : "Выйти из группы"}
              </Button>
            )}
            {chat.my_role === "owner" && (
              <Button
                variant="outline"
                className="w-full text-destructive"
                onClick={() => void removeGroup()}
              >
                <Trash2 /> {channel ? "Удалить канал" : "Удалить группу"}
              </Button>
            )}
          </div>
        )}
        <AddMembersDialog
          chatId={chat.id}
          existing={(members.data ?? []).map((m) => m.user_id)}
          open={adding}
          onClose={() => setAdding(false)}
        />
        <Dialog open={editing} onOpenChange={setEditing}>
          <DialogContent className="sm:max-w-md">
            {editing && (
              <EditGroupForm chat={chat} onSaved={refresh} onClose={() => setEditing(false)} />
            )}
          </DialogContent>
        </Dialog>
        {confirmDialog}
      </SheetContent>
    </Sheet>
  );
}

/** «Изменить группу»: название и описание (3.5.1). */
function EditGroupForm({
  chat,
  onSaved,
  onClose,
}: {
  chat: ChatRow;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const channel = !!chat.settings?.channel;
  const [title, setTitle] = useState(chat.title ?? "");
  const [description, setDescription] = useState(chat.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!title.trim()) {
      setError(channel ? "Укажите название канала" : "Укажите название группы");
      return;
    }
    setBusy(true);
    try {
      await chatRpc("chat_update", {
        p_chat: chat.id,
        p: { title: title.trim(), description: description.trim() },
      });
      await onSaved();
      toast.success("Сохранено");
      onClose();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{channel ? "Изменить канал" : "Изменить группу"}</DialogTitle>
        <DialogDescription>Название и описание видят все участники.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void save()}>
        <DialogBody className="space-y-4">
          <FormField label="Название" required error={error}>
            <Input
              autoFocus
              value={title}
              maxLength={100}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
            />
          </FormField>
          <FormField label="Описание" optional>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={1000}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/**
 * «Что могут участники» (3.5.2, как «Разрешения участников» в Telegram):
 * выключено — только администраторы. Применяется сразу. Темы — здесь же;
 * выключить их можно, когда тем нет (3.5.6).
 */
function GroupPermissions({ chat, onSaved }: { chat: ChatRow; onSaved: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const { data: all = [] } = useChatList();
  const [busy, setBusy] = useState(false);
  const channel = !!chat.settings?.channel;
  const topicsOn = !!chat.settings?.topics;
  const hasTopics = all.some((c) => c.kind === "topic" && c.parent_id === chat.id);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      await onSaved();
      toast.success(ok);
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const setting = (key: "pin" | "post" | "add", on: boolean, label: string) =>
    void run(
      () =>
        chatRpc("chat_update", {
          p_chat: chat.id,
          p: { settings: { [key]: on ? "all" : "admins" } },
        }),
      on ? `Участники могут ${label}` : `${capital(label)} — только администраторы`,
    );

  const rows: { key: "post" | "pin" | "add"; label: string }[] = [
    ...(channel ? [] : [{ key: "post" as const, label: "писать сообщения" }]),
    { key: "pin", label: "закреплять сообщения" },
    { key: "add", label: "добавлять людей" },
  ];

  return (
    <div className="space-y-3 border-b p-4">
      <div>
        <h3 className="text-sm font-semibold">Что могут участники</h3>
        <p className="text-xs text-muted-foreground">Выключено — только администраторы.</p>
      </div>
      {channel && (
        <p className="text-sm text-muted-foreground">
          Это канал: пишут только владелец и администраторы, у каждого поста — «Прочитал».
        </p>
      )}
      {rows.map(({ key, label }) => (
        <SwitchRow
          key={key}
          title={capital(label)}
          checked={(chat.settings?.[key] ?? (key === "post" ? "all" : "admins")) === "all"}
          disabled={busy}
          onCheckedChange={(v) => setting(key, v, label)}
        />
      ))}
      {!channel && topicsOn && (
        <SwitchRow
          title="Создавать темы"
          checked={chat.settings?.topic_create === "all"}
          disabled={busy}
          onCheckedChange={(v) =>
            void run(
              () => setTopicsEnabled(qc, chat.id, true, v ? "all" : "admins"),
              v ? "Участники могут создавать темы" : "Темы создают только администраторы",
            )
          }
        />
      )}
      {!channel && (
        <SwitchRow
          title="Темы"
          hint={
            topicsOn && hasTopics
              ? "Чтобы выключить, удалите все темы"
              : "Переписка делится на темы, как в Telegram: «Отчёты», «Акции», «Вопросы по 1С»"
          }
          checked={topicsOn}
          disabled={busy || (topicsOn && hasTopics)}
          onCheckedChange={(v) =>
            void run(
              () => setTopicsEnabled(qc, chat.id, v),
              v ? "Темы включены: прежняя переписка — тема «Общая»" : "Темы выключены",
            )
          }
        />
      )}
    </div>
  );
}

function MediaThumb({ file, onClick }: { file: ChatAttachment; onClick: () => void }) {
  const { data: url } = useChatFileUrl(isImage(file.mime) ? file.path : null);
  return (
    <button
      type="button"
      onClick={onClick}
      className="aspect-square overflow-hidden rounded-md bg-muted"
      title={file.name}
    >
      {url ? (
        <img src={url} alt={file.name} loading="lazy" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center p-1 text-[10px] text-muted-foreground">
          {file.name}
        </span>
      )}
    </button>
  );
}

function FilesTab({
  chatId,
  kind,
  onJump,
}: {
  chatId: string;
  kind: "media" | "files";
  onJump: (seq: number) => void;
}) {
  const { data = [], isPending } = useQuery({
    queryKey: ["chat_files", chatId, kind],
    queryFn: async () =>
      (
        (await chatRpc<
          | { seq: number; author_id: string | null; created_at: string; file: ChatAttachment }[]
          | null
        >("chat_files", { p_chat: chatId, p_kind: kind, p_limit: 120 })) ?? []
      ).map((r) => ({ ...r, seq: Number(r.seq) })),
  });
  if (isPending) return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />;
  if (data.length === 0)
    return (
      <p className="text-center text-sm text-muted-foreground">
        {kind === "media" ? "Фото и видео нет" : "Файлов нет"}
      </p>
    );
  if (kind === "media")
    return (
      <div className="grid grid-cols-3 gap-1">
        {data.map((r) => (
          <MediaThumb key={r.file.path + r.seq} file={r.file} onClick={() => onJump(r.seq)} />
        ))}
      </div>
    );
  return (
    <div className="space-y-2">
      {data.map((r) => (
        <div key={r.file.path + r.seq}>
          <button
            type="button"
            className="mb-0.5 text-xs text-muted-foreground hover:underline"
            onClick={() => onJump(r.seq)}
          >
            {dayLabel(r.created_at)}
          </button>
          {isVoice(r.file) ? <VoicePlayer file={r.file} /> : <FileCard file={r.file} />}
        </div>
      ))}
    </div>
  );
}

function LinksTab({ chatId, onJump }: { chatId: string; onJump: (seq: number) => void }) {
  const { data = [], isPending } = useQuery({
    queryKey: ["chat_links", chatId],
    queryFn: async () =>
      (
        (await chatRpc<{ seq: number; created_at: string; url: string }[] | null>("chat_links", {
          p_chat: chatId,
        })) ?? []
      ).map((r) => ({ ...r, seq: Number(r.seq) })),
  });
  if (isPending) return <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />;
  if (data.length === 0)
    return <p className="text-center text-sm text-muted-foreground">Ссылок нет</p>;
  return (
    <ul className="space-y-2">
      {data.map((r, i) => (
        <li key={i} className="rounded-md border p-2">
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-sm text-sky-700 hover:underline"
          >
            {r.url}
          </a>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => onJump(r.seq)}
          >
            {dayLabel(r.created_at)} · к сообщению
          </button>
        </li>
      ))}
    </ul>
  );
}

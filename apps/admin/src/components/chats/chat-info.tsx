/**
 * Сведения о чате — шторка справа: уведомления чата, участники и роли,
 * медиа / файлы / ссылки (бриф 2.14, боль № 33), настройки группы (кто
 * закрепляет, кто пишет, кто добавляет), выход и удаление группы.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link2,
  Loader2,
  LogOut,
  Pin,
  PinOff,
  Trash2,
  UserMinus,
  UserPlus,
  Shield,
} from "lucide-react";
import { toast } from "sonner";

import { FileCard } from "@/components/chats/attachments";
import { ChatAvatar } from "@/components/chats/chat-avatar";
import { ChatSourcesBlock } from "@/components/chats/chat-sources";
import { AddMembersDialog } from "@/components/chats/dialogs";
import { useConfirm } from "@/components/confirm-dialog";
import { StaffAvatar } from "@/components/employee-photo";
import { PersonButton } from "@/components/people/person-card";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { StatusChip } from "@/components/ui/status-chip";
import { Textarea } from "@/components/ui/textarea";
import { chatTitle, dayLabel, isImage } from "@/lib/chats/content";
import { chatErrorText, chatMembersQuery, chatRpc } from "@/lib/chats/data";
import { useChatFileUrl } from "@/lib/chats/files";
import { usePeople } from "@/lib/chats/people";
import type { ChatAttachment, ChatNotify, ChatRow } from "@/lib/chats/types";
import { lastSeenLabel } from "@/lib/company";

type Tab = "members" | "media" | "files" | "links";

const ROLE_LABEL = { owner: "Владелец", admin: "Админ", member: "" } as const;

export function ChatInfo({
  chat,
  me,
  open,
  onClose,
  onJump,
}: {
  chat: ChatRow;
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

  const notifyValue: ChatNotify = chat.notify;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="items-center gap-2 border-b p-6 text-center">
          <ChatAvatar chat={chat} title={title} />
          <SheetTitle className="text-center">{title}</SheetTitle>
          <SheetDescription className="text-center">
            {chat.kind === "direct"
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
            <FormField label="Уведомления чата">
              <Select
                value={notifyValue}
                onValueChange={(v) =>
                  void call("chat_set_notify", {
                    p_chat: chat.id,
                    p_notify: v,
                    p_muted_until: null,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все сообщения</SelectItem>
                  <SelectItem value="mentions">Только упоминания и ответы</SelectItem>
                  <SelectItem value="none">Без уведомлений и счётчика</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void call("chat_set_pinned", { p_chat: chat.id, p_on: !chat.pinned_at })}
          >
            {chat.pinned_at ? <PinOff /> : <Pin />}
            {chat.pinned_at ? "Открепить в списке" : "Закрепить в списке"}
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
            <Link2 /> Ссылка на чат
          </Button>
        </div>

        {isGroup && isAdmin && (
          <GroupSettings key={chat.id + chat.title} chat={chat} onSaved={refresh} />
        )}
        {isGroup && <ChatSourcesBlock chat={chat} open={open} />}

        <div className="border-b p-4">
          <SegmentedControl
            aria-label="Что показать"
            fullWidth
            value={tab}
            onChange={setTab}
            options={[
              ...(chat.kind === "self" ? [] : [{ value: "members" as Tab, label: "Участники" }]),
              { value: "media", label: "Медиа" },
              { value: "files", label: "Файлы" },
              { value: "links", label: "Ссылки" },
            ]}
          />
        </div>

        <div className="flex-1 p-4">
          {tab === "members" && (
            <div className="space-y-1">
              {isGroup && (isAdmin || chat.settings?.add === "all") && (
                <Button variant="outline" className="mb-2 w-full" onClick={() => setAdding(true)}>
                  <UserPlus /> Добавить участников
                </Button>
              )}
              {members.isPending ? (
                <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
              ) : (
                (members.data ?? []).map((m) => (
                  <div
                    key={m.user_id}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50"
                  >
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
                          {m.user_id === me && <span className="text-muted-foreground"> · вы</span>}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[
                            m.source === "auto" ? "из оргструктуры" : null,
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
                    {isGroup && chat.my_role === "owner" && m.role !== "owner" && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        title={m.role === "admin" ? "Снять админа" : "Сделать админом"}
                        aria-label={m.role === "admin" ? "Снять админа" : "Сделать админом"}
                        onClick={() =>
                          void call("chat_member_set_role", {
                            p_chat: chat.id,
                            p_user: m.user_id,
                            p_role: m.role === "admin" ? "member" : "admin",
                          })
                        }
                      >
                        <Shield className="size-4" />
                      </Button>
                    )}
                    {isGroup &&
                      m.user_id !== me &&
                      m.role !== "owner" &&
                      m.source !== "auto" &&
                      (chat.my_role === "owner" ||
                        (chat.my_role === "admin" && m.role === "member")) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-8"
                          title={channel ? "Убрать из канала" : "Убрать из группы"}
                          aria-label={channel ? "Убрать из канала" : "Убрать из группы"}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Убрать ${name(m.user_id)} из ${channel ? "канала" : "группы"}?`,
                              confirmLabel: "Убрать",
                            });
                            if (ok)
                              void call("chat_member_remove", {
                                p_chat: chat.id,
                                p_user: m.user_id,
                              });
                          }}
                        >
                          <UserMinus className="size-4" />
                        </Button>
                      )}
                  </div>
                ))
              )}
            </div>
          )}
          {tab === "media" && <FilesTab chatId={chat.id} kind="media" onJump={onJump} />}
          {tab === "files" && <FilesTab chatId={chat.id} kind="files" onJump={onJump} />}
          {tab === "links" && <LinksTab chatId={chat.id} onJump={onJump} />}
        </div>

        {isGroup && (
          <div className="space-y-2 border-t p-4">
            {myAuto ? (
              <p className="text-xs text-muted-foreground">
                Вы здесь по оргструктуре — выйти нельзя, но можно выключить уведомления выше.
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
        {confirmDialog}
      </SheetContent>
    </Sheet>
  );
}

function GroupSettings({ chat, onSaved }: { chat: ChatRow; onSaved: () => Promise<unknown> }) {
  const [title, setTitle] = useState(chat.title ?? "");
  const [description, setDescription] = useState(chat.description ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = title !== (chat.title ?? "") || description !== (chat.description ?? "");
  const save = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await chatRpc("chat_update", { p_chat: chat.id, p: patch });
      await onSaved();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  const setting = (key: "pin" | "post" | "add", value: string) =>
    void save({ settings: { [key]: value } });
  return (
    <div className="space-y-3 border-b p-4">
      <FormField label={chat.settings?.channel ? "Название канала" : "Название группы"}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
      </FormField>
      <FormField label="Описание" optional>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          maxLength={1000}
        />
      </FormField>
      {dirty && (
        <Button disabled={busy || !title.trim()} onClick={() => void save({ title, description })}>
          {busy && <Loader2 className="animate-spin" />} Сохранить
        </Button>
      )}
      {chat.settings?.channel && (
        <p className="text-sm text-muted-foreground">
          Канал: пишут владелец и админы, у каждого поста — «Прочитал».
        </p>
      )}
      {(
        [
          ["post", "Кто пишет"],
          ["pin", "Кто закрепляет"],
          ["add", "Кто добавляет участников"],
        ] as const
      )
        .filter(([key]) => !(chat.settings?.channel && key === "post"))
        .map(([key, label]) => (
          <FormField key={key} label={label} htmlFor={null}>
            <SegmentedControl
              aria-label={label}
              fullWidth
              value={chat.settings?.[key] ?? (key === "post" ? "all" : "admins")}
              onChange={(v) => setting(key, v)}
              options={[
                { value: "all", label: "Все участники" },
                { value: "admins", label: "Только админы" },
              ]}
            />
          </FormField>
        ))}
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
          <FileCard file={r.file} />
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

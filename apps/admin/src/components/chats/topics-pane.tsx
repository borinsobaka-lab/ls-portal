/**
 * Темы группы (TASKS_CHATS_PLAN.md, этап 2, Д.5 — «как в Telegram»): колонка
 * рядом с перепиской. «Общая» — сама группа (прежняя переписка), ниже темы:
 * открытые, свежие сверху, закрытые — ниже с замком. У темы — цвет,
 * непрочитанное, последнее сообщение; «⋯» — переименовать, цвет, закрыть /
 * открыть, звук, удалить (автор темы и админы группы). «Новая тема» — админам
 * или всем, если так настроено в группе. Схема —
 * db/migrations/2026-11-08_zzzzzzzzzzzzz_chat_topics.sql.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  AtSign,
  BellOff,
  Check,
  Hash,
  Info,
  Loader2,
  LockKeyhole,
  LockOpen,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Volume2,
} from "lucide-react";
import { toast } from "sonner";

import { ChatAvatar } from "@/components/chats/chat-avatar";
import { useConfirm } from "@/components/confirm-dialog";
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
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { chatTime, chatTitle, systemText } from "@/lib/chats/content";
import { chatErrorText, chatRpc, createTopic, deleteTopic, updateTopic } from "@/lib/chats/data";
import { shortName, usePeople } from "@/lib/chats/people";
import {
  canCreateTopic,
  canManageTopic,
  TOPIC_COLOR_KEYS,
  TOPIC_COLORS,
  topicColor,
  topicsOf,
} from "@/lib/chats/topics";
import type { ChatRow } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted";

const isMuted = (c: ChatRow) =>
  c.notify === "none" || (!!c.muted_until && new Date(c.muted_until) > new Date());

export function TopicsPane({
  group,
  chats,
  activeId,
  me,
  onOpen,
  onBack,
  onInfo,
  className,
}: {
  group: ChatRow;
  chats: ChatRow[];
  /** Открытая тема; группа — «Общая»; null — ничего (телефон). */
  activeId: string | null;
  me: string;
  onOpen: (chatId: string, general?: boolean) => void;
  onBack: () => void;
  onInfo: () => void;
  className?: string;
}) {
  const { name } = usePeople();
  const [editing, setEditing] = useState<ChatRow | "new" | null>(null);
  const topics = topicsOf(chats, group.id);
  const title = chatTitle(group, name);

  return (
    <div className={cn("flex min-h-0 flex-col bg-background", className)}>
      <header className="flex h-14 shrink-0 items-center gap-1 border-b px-2 md:h-16">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="К списку чатов"
          onClick={onBack}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <button
          type="button"
          onClick={onInfo}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 text-left"
        >
          <ChatAvatar chat={group} title={title} size="sm" />
          <span className="min-w-0">
            <span className="block truncate font-semibold">{title}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {topics.length ? `${topics.length} ${topicsWord(topics.length)}` : "Темы включены"}
            </span>
          </span>
        </button>
        <Button variant="ghost" size="icon" aria-label="Сведения о группе" onClick={onInfo}>
          <Info className="size-5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        <TopicRow
          chat={group}
          label="Общая"
          general
          active={activeId === group.id}
          me={me}
          onOpen={() => onOpen(group.id, true)}
        />
        {topics.map((t) => (
          <TopicRow
            key={t.id}
            chat={t}
            label={t.title ?? "Тема"}
            active={activeId === t.id}
            me={me}
            onOpen={() => onOpen(t.id)}
            menu={<TopicMenu topic={t} group={group} me={me} onEdit={() => setEditing(t)} />}
          />
        ))}
        {topics.length === 0 && (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            Тем пока нет. Разделите переписку по темам: «Отчёты», «Акции», «Вопросы по 1С» — так
            сообщения не теряются в общем потоке.
          </p>
        )}
      </div>

      {canCreateTopic(group) && (
        <div className="shrink-0 border-t p-2">
          <Button variant="outline" className="w-full" onClick={() => setEditing("new")}>
            <Plus className="size-4" /> Новая тема
          </Button>
        </div>
      )}

      <TopicDialog
        target={editing}
        group={group}
        onClose={() => setEditing(null)}
        onCreated={(id) => onOpen(id)}
      />
    </div>
  );
}

const topicsWord = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? "тема"
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
      ? "темы"
      : "тем";

function TopicRow({
  chat,
  label,
  general = false,
  active,
  me,
  onOpen,
  menu,
}: {
  chat: ChatRow;
  label: string;
  general?: boolean;
  active: boolean;
  me: string;
  onOpen: () => void;
  menu?: React.ReactNode;
}) {
  const { name } = usePeople();
  const last = chat.last_message;
  const preview = !last
    ? "Нет сообщений"
    : last.kind === "system"
      ? systemText(last.system, last.author_id, (id) => name(id))
      : last.deleted
        ? "Сообщение удалено"
        : `${last.author_id === me ? "Вы" : shortName(name(last.author_id))}: ${last.text}`;
  const muted = isMuted(chat);
  const color = topicColor(chat.settings?.color);
  return (
    <div
      className={cn(
        "group/topic relative flex items-center rounded-lg transition-colors",
        active ? "bg-selected/8" : "hover:bg-muted",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
      >
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-full"
          style={general ? undefined : { backgroundColor: `${color}22`, color }}
        >
          {general ? (
            <MessagesSquare className="size-[18px] text-muted-foreground" />
          ) : (
            <Hash className="size-[18px]" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate",
                chat.unread ? "font-semibold" : "font-medium",
              )}
            >
              {label}
            </span>
            {chat.settings?.closed && (
              <LockKeyhole
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label="Закрыта"
              />
            )}
            {muted && !general && <BellOff className="size-3.5 shrink-0 text-muted-foreground" />}
            <span className="shrink-0 text-xs text-muted-foreground">
              {chatTime(chat.last_message_at ?? chat.created_at)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{preview}</span>
            {chat.mentions > 0 && (
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-selected text-selected-foreground">
                <AtSign className="size-3" />
              </span>
            )}
            {chat.unread > 0 && (
              <span
                className={cn(
                  "min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs leading-5 font-semibold text-white",
                  muted ? "bg-muted-foreground" : "bg-destructive",
                )}
              >
                {chat.unread > 99 ? "99+" : chat.unread}
              </span>
            )}
          </span>
        </span>
      </button>
      {menu}
    </div>
  );
}

function TopicMenu({
  topic,
  group,
  me,
  onEdit,
}: {
  topic: ChatRow;
  group: ChatRow;
  me: string;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  const manage = canManageTopic(topic, group, me);
  const muted = isMuted(topic);
  const run = async (fn: () => Promise<unknown>) => {
    setOpen(false);
    try {
      await fn();
    } catch (e) {
      toast.error(chatErrorText(e));
    }
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="mr-1 size-8 shrink-0 opacity-100 md:opacity-0 md:group-hover/topic:opacity-100 md:data-[state=open]:opacity-100"
            aria-label={`Действия с темой «${topic.title}»`}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-56 p-1">
          <button
            type="button"
            className={MENU_ITEM}
            onClick={() =>
              void run(async () => {
                await chatRpc("chat_set_notify", {
                  p_chat: topic.id,
                  p_notify: muted ? "all" : "none",
                  p_muted_until: null,
                });
                await qc.invalidateQueries({ queryKey: ["chat_list"] });
                await qc.invalidateQueries({ queryKey: ["chat_unread"] });
              })
            }
          >
            {muted ? <Volume2 className="size-4" /> : <BellOff className="size-4" />}
            {muted ? "Включить звук" : "Без звука"}
          </button>
          {manage && (
            <>
              <button
                type="button"
                className={MENU_ITEM}
                onClick={() => {
                  setOpen(false);
                  onEdit();
                }}
              >
                <Pencil className="size-4" /> Название и цвет
              </button>
              <button
                type="button"
                className={MENU_ITEM}
                onClick={() =>
                  void run(() => updateTopic(qc, topic.id, { closed: !topic.settings?.closed }))
                }
              >
                {topic.settings?.closed ? (
                  <LockOpen className="size-4" />
                ) : (
                  <LockKeyhole className="size-4" />
                )}
                {topic.settings?.closed ? "Открыть тему" : "Закрыть тему"}
              </button>
              <button
                type="button"
                className={cn(MENU_ITEM, "text-destructive")}
                onClick={() =>
                  void run(async () => {
                    const ok = await confirm({
                      title: `Удалить тему «${topic.title}»?`,
                      description: "Её сообщения и файлы удалятся у всех участников группы.",
                      confirmLabel: "Удалить",
                    });
                    if (ok) await deleteTopic(qc, topic.id);
                  })
                }
              >
                <Trash2 className="size-4" /> Удалить тему
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>
      {confirmDialog}
    </>
  );
}

/** Новая тема или её название и цвет. */
export function TopicDialog({
  target,
  group,
  onClose,
  onCreated,
}: {
  target: ChatRow | "new" | null;
  group: ChatRow;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {target && (
          <TopicForm
            key={target === "new" ? "new" : target.id}
            topic={target === "new" ? null : target}
            group={group}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function TopicForm({
  topic,
  group,
  onClose,
  onCreated,
}: {
  topic: ChatRow | null;
  group: ChatRow;
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(topic?.title ?? "");
  const [color, setColor] = useState(topic?.settings?.color ?? "blue");
  const [busy, setBusy] = useState(false);
  return (
    <DialogForm
      onSubmit={async () => {
        if (!title.trim()) {
          toast.error("Напишите название темы");
          return;
        }
        setBusy(true);
        try {
          if (topic) {
            await updateTopic(qc, topic.id, { title: title.trim(), color });
          } else {
            const id = await createTopic(qc, group.id, title.trim(), color);
            onCreated?.(id);
          }
          onClose();
        } catch (e) {
          toast.error(chatErrorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>{topic ? "Тема" : "Новая тема"}</DialogTitle>
        <DialogDescription>
          {topic
            ? "Название и цвет видят все участники группы."
            : `В группе «${group.title ?? "Группа"}» — для всех её участников.`}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4 px-0">
        <FormField label="Название" required htmlFor="topic-title">
          <Input
            id="topic-title"
            autoFocus
            maxLength={100}
            value={title}
            placeholder="Например: Отчёты, Акции, Вопросы по 1С"
            onChange={(e) => setTitle(e.target.value)}
          />
        </FormField>
        <FormField label="Цвет" htmlFor={null}>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Цвет темы">
            {TOPIC_COLOR_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={color === c}
                aria-label={TOPIC_COLORS[c].label}
                title={TOPIC_COLORS[c].label}
                className="flex size-8 items-center justify-center rounded-full ring-offset-2 ring-offset-background aria-checked:ring-2 aria-checked:ring-foreground"
                style={{ backgroundColor: TOPIC_COLORS[c].hex }}
                onClick={() => setColor(c)}
              >
                {color === c && <Check className="size-4 text-white" />}
              </button>
            ))}
          </div>
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Отмена
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {topic ? "Сохранить" : "Создать тему"}
        </Button>
      </DialogFooter>
    </DialogForm>
  );
}

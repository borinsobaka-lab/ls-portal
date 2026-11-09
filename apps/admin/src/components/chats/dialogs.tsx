/**
 * Окна чатов: «Кто прочитал», «Переслать», «Написать сотруднику», группа, чат
 * подразделения и канал, папка (название и чаты), выбор людей с поиском.
 * Ошибки заполнения — под полями, не тостами (UI_REVIEW, 3.6).
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Users, X } from "lucide-react";
import { toast } from "sonner";

import { ChatAvatar } from "@/components/chats/chat-avatar";
import { StaffAvatar } from "@/components/employee-photo";
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
import { SearchInput } from "@/components/ui/search-input";
import { chatMatches, chatTitle } from "@/lib/chats/content";
import { SourcesEditor } from "@/components/chats/chat-sources";
import { Textarea } from "@/components/ui/textarea";
import {
  chatErrorText,
  chatListQuery,
  chatRpc,
  createChatEx,
  createGroup,
  openDirect,
  useSourceOptions,
} from "@/lib/chats/data";
import { usePeople } from "@/lib/chats/people";
import type { ChatMessage, ChatRow, ChatSource } from "@/lib/chats/types";
import { matchPerson } from "@/lib/company";
import { cn } from "@/lib/utils";

// ---- Выбор людей ----------------------------------------------------------------

/**
 * Выбор людей из справочника «Компании». Несколько — выбранные чипами над
 * поиском (крестик убирает), с `onDone` внизу строка «Выбрано: N · Готово»
 * (как в Telegram: видно, кого выбрали, и понятно, как закончить).
 */
export function PeoplePicker({
  selected,
  onToggle,
  exclude = [],
  single = false,
  onDone,
}: {
  selected: string[];
  onToggle: (id: string) => void;
  exclude?: string[];
  single?: boolean;
  /** Кнопка «Готово» внизу (в выпадающем окне — закрыть его). */
  onDone?: () => void;
}) {
  const { people, loading, name } = usePeople();
  const [q, setQ] = useState("");
  const list = useMemo(
    () => people.filter((p) => !exclude.includes(p.user_id) && matchPerson(p, q)).slice(0, 200),
    [people, q, exclude],
  );
  return (
    <div className="space-y-2">
      {!single && selected.length > 0 && (
        <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
          {selected.map((uid) => (
            <span
              key={uid}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-selected/10 py-0.5 pr-1 pl-2.5 text-sm"
            >
              <span className="truncate">{name(uid)}</span>
              <button
                type="button"
                aria-label={`Убрать: ${name(uid)}`}
                title="Убрать"
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => onToggle(uid)}
              >
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <SearchInput value={q} onChange={setQ} placeholder="Имя, должность, отдел, город" autoFocus />
      <div className="max-h-80 overflow-y-auto rounded-md border">
        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : list.length === 0 ? (
          <p className="p-4 text-center text-sm text-muted-foreground">Ничего не найдено</p>
        ) : (
          list.map((p) => {
            const on = selected.includes(p.user_id);
            return (
              <button
                key={p.user_id}
                type="button"
                onClick={() => onToggle(p.user_id)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted",
                  on && "bg-muted",
                )}
              >
                <StaffAvatar
                  value={p.avatar_url}
                  name={p.full_name}
                  className="size-8 text-[10px]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.full_name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {[p.position_name, p.units[0]?.name, p.cities[0]].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {!single && (
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border",
                      on && "border-selected bg-selected text-selected-foreground",
                    )}
                  >
                    {on && <Check className="size-3.5" />}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
      {onDone && !single && (
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-sm text-muted-foreground">Выбрано: {selected.length}</span>
          <Button size="sm" onClick={onDone}>
            Готово
          </Button>
        </div>
      )}
    </div>
  );
}

// ---- Новый чат ------------------------------------------------------------------

/** Что создаём: личный чат, группа, чат подразделения (состав из оргструктуры), канал. */
export type NewChatMode = "direct" | "group" | "unit" | "channel";

export function NewChatDialog({
  mode,
  onClose,
  onOpened,
}: {
  mode: NewChatMode | null;
  onClose: () => void;
  onOpened: (chatId: string) => void;
}) {
  return (
    <Dialog open={!!mode} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[92dvh] flex-col sm:max-w-lg">
        {mode && <NewChatForm key={mode} mode={mode} onClose={onClose} onOpened={onOpened} />}
      </DialogContent>
    </Dialog>
  );
}

const NEW_CHAT_TEXT = {
  group: {
    title: "Новая группа",
    description: "Название и участники. Позже участников можно добавить и убрать.",
    submit: "Создать группу",
    placeholder: "Например, Отдел развития",
  },
  unit: {
    title: "Чат подразделения",
    description:
      "Участники — из оргструктуры: новые сотрудники подразделения попадают в чат сами, ушедшие — уходят.",
    submit: "Создать чат",
    placeholder: "Например, Отдел развития",
  },
  channel: {
    title: "Новый канал",
    description:
      "Объявления: пишут только администраторы канала, у каждого поста — «Прочитал» и список, кто ещё не прочитал.",
    submit: "Создать канал",
    placeholder: "Например, Новости Lady Stretch",
  },
} as const;

function NewChatForm({
  mode,
  onClose,
  onOpened,
}: {
  mode: NewChatMode;
  onClose: () => void;
  onOpened: (chatId: string) => void;
}) {
  const qc = useQueryClient();
  const opts = useSourceOptions();
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [sources, setSources] = useState<ChatSource[]>(() =>
    mode === "unit" && opts.units[0]
      ? [{ kind: "unit", unit_id: opts.units[0], scope: "all", with_subunits: true }]
      : mode === "channel" && opts.announce
        ? [{ kind: "all", unit_id: null, scope: "all", with_subunits: true }]
        : [],
  );
  const [busy, setBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);

  const openWith = async (id: string) => {
    setBusy(true);
    try {
      const chatId = await openDirect(id);
      await qc.invalidateQueries({ queryKey: ["chat_list"] });
      onOpened(chatId);
      onClose();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!title.trim()) {
      setTitleError(mode === "channel" ? "Укажите название канала" : "Укажите название");
      return;
    }
    if (mode === "unit" && !sources.some((x) => x.kind === "unit")) {
      setSourcesError("Выберите подразделение");
      return;
    }
    setBusy(true);
    try {
      const chatId =
        mode === "group"
          ? await createGroup(title.trim(), selected)
          : await createChatEx({
              title: title.trim(),
              description: description.trim() || undefined,
              channel: mode === "channel",
              members: selected,
              sources,
            });
      await qc.invalidateQueries({ queryKey: ["chat_list"] });
      onOpened(chatId);
      onClose();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "direct") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Написать сотруднику</DialogTitle>
          <DialogDescription>
            Выберите, кому написать, — откроется личная переписка.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <PeoplePicker selected={[]} single onToggle={(id) => !busy && void openWith(id)} />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
        </DialogFooter>
      </>
    );
  }
  const text = NEW_CHAT_TEXT[mode];
  return (
    <>
      <DialogHeader>
        <DialogTitle>{text.title}</DialogTitle>
        <DialogDescription>{text.description}</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void create()}>
        <DialogBody className="space-y-4">
          <FormField label="Название" required error={titleError}>
            <Input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setTitleError(null);
              }}
              maxLength={100}
              placeholder={text.placeholder}
            />
          </FormField>
          {mode !== "group" && (
            <>
              <FormField label="Описание" optional>
                <Textarea
                  rows={2}
                  maxLength={1000}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </FormField>
              <FormField
                label="Кто в чате автоматически"
                required={mode === "unit"}
                hint={
                  mode === "channel"
                    ? "Можно оставить пустым и добавить людей вручную"
                    : "Новые сотрудники подразделения попадут в чат сами"
                }
                error={sourcesError}
                htmlFor={null}
              >
                <SourcesEditor
                  value={sources}
                  onChange={(v) => {
                    setSources(v);
                    setSourcesError(null);
                  }}
                />
              </FormField>
            </>
          )}
          <FormField
            label={`${mode === "group" ? "Участники" : "Ещё участники вручную"}${
              selected.length ? ` · ${selected.length}` : ""
            }`}
            optional={mode !== "group"}
            htmlFor={null}
          >
            <PeoplePicker
              selected={selected}
              onToggle={(id) =>
                setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
              }
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} {text.submit}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

// ---- Добавить участников --------------------------------------------------------

export function AddMembersDialog({
  chatId,
  existing,
  open,
  onClose,
}: {
  chatId: string;
  existing: string[];
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await chatRpc("chat_members_add", { p_chat: chatId, p_users: selected });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["chat_members", chatId] }),
        qc.invalidateQueries({ queryKey: ["chat_list"] }),
      ]);
      toast.success(selected.length > 1 ? `Добавлено: ${selected.length}` : "Участник добавлен");
      setSelected([]);
      onClose();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Добавить участников</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <PeoplePicker
            selected={selected}
            exclude={existing}
            onToggle={(id) =>
              setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
            }
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy || selected.length === 0} onClick={() => void add()}>
            {busy && <Loader2 className="animate-spin" />} Добавить
            {selected.length ? ` (${selected.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Кто прочитал ---------------------------------------------------------------

export function ReceiptsDialog({
  message,
  onClose,
}: {
  message: ChatMessage | null;
  onClose: () => void;
}) {
  const { name, person } = usePeople();
  const { data, isLoading } = useQuery({
    queryKey: ["chat_receipts", message?.id],
    queryFn: () =>
      chatRpc<{ read: string[]; total: number }>("chat_read_receipts", { p_message: message!.id }),
    enabled: !!message,
  });
  return (
    <Dialog open={!!message} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Кто прочитал</DialogTitle>
          {data && (
            <DialogDescription>
              Прочитали {data.read.length} из {Number(data.total)}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogBody>
          {isLoading ? (
            <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
          ) : data && data.read.length > 0 ? (
            <ul className="space-y-2">
              {data.read.map((id) => (
                <li key={id} className="flex items-center gap-2 text-sm">
                  <StaffAvatar
                    value={person(id)?.avatar_url}
                    name={name(id)}
                    className="size-7 text-[10px]"
                  />
                  {name(id)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Пока никто не прочитал.</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Переслать ------------------------------------------------------------------

export function ForwardDialog({
  messages,
  onClose,
}: {
  messages: ChatMessage[] | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: chats = [] } = useQuery(chatListQuery);
  const { name } = usePeople();
  const [q, setQ] = useState("");
  const [to, setTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const list = chats.filter((c) => chatMatches(chatTitle(c, name), q));

  const send = async () => {
    setBusy(true);
    try {
      await chatRpc("chat_forward", { p_messages: messages!.map((m) => m.id), p_to: to });
      await qc.invalidateQueries({ queryKey: ["chat_list"] });
      toast.success(to.length > 1 ? `Переслано в ${to.length} чата` : "Переслано");
      setTo([]);
      onClose();
    } catch (e) {
      toast.error(chatErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!messages} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Переслать</DialogTitle>
          <DialogDescription>
            Выберите чаты — можно несколько, не больше {FORWARD_MAX}.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-2">
          <SearchInput value={q} onChange={setQ} placeholder="Поиск чата" autoFocus />
          <div className="max-h-80 overflow-y-auto rounded-md border">
            {list.length === 0 && (
              <p className="p-4 text-center text-sm text-muted-foreground">Ничего не найдено</p>
            )}
            {list.map((c) => {
              const t = chatTitle(c, name);
              const on = to.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    if (!on && to.length >= FORWARD_MAX) {
                      toast.info(`Можно выбрать не больше ${FORWARD_MAX} чатов`);
                      return;
                    }
                    setTo((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]));
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted",
                    on && "bg-muted",
                  )}
                >
                  <ChatAvatar chat={c} title={t} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{t}</span>
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-full border",
                      on && "border-selected bg-selected text-selected-foreground",
                    )}
                  >
                    {on && <Check className="size-3.5" />}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy || to.length === 0} onClick={() => void send()}>
            {busy && <Loader2 className="animate-spin" />} Переслать
            {to.length ? ` (${to.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FORWARD_MAX = 20;

// ---- Папка ----------------------------------------------------------------------

export function FolderDialog({
  folder,
  onClose,
}: {
  /** null — закрыто, {} — новая папка. */
  folder: { id?: string; title?: string; chat_ids?: string[] } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!folder} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        {folder && <FolderForm key={folder.id ?? "new"} folder={folder} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function FolderForm({
  folder,
  onClose,
}: {
  folder: { id?: string; title?: string; chat_ids?: string[] };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: chats = [] } = useQuery(chatListQuery);
  const { name } = usePeople();
  const [title, setTitle] = useState(folder.title ?? "");
  const [ids, setIds] = useState<string[]>(folder.chat_ids ?? []);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = chats.filter(
    (c: ChatRow) => c.kind !== "topic" && chatMatches(chatTitle(c, name), q),
  );

  const save = async () => {
    if (!title.trim()) {
      setError("Укажите название папки");
      return;
    }
    setBusy(true);
    try {
      await chatRpc("chat_folder_save", {
        p_id: folder.id ?? null,
        p_title: title.trim(),
        p_chat_ids: ids,
      });
      await qc.invalidateQueries({ queryKey: ["chat_folders"] });
      toast.success(folder.id ? "Папка сохранена" : `Папка «${title.trim()}» создана`);
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
        <DialogTitle>{folder.id ? "Изменить папку" : "Новая папка"}</DialogTitle>
        <DialogDescription>Название и чаты, которые в неё входят.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => void save()}>
        <DialogBody className="space-y-4">
          <FormField label="Название" required error={error}>
            <Input
              value={title}
              autoFocus={!folder.id}
              onChange={(e) => {
                setTitle(e.target.value);
                setError(null);
              }}
              maxLength={40}
              placeholder="Например, Партнёры"
            />
          </FormField>
          <FormField label={`Чаты${ids.length ? ` · ${ids.length}` : ""}`} htmlFor={null}>
            <div className="space-y-2">
              <SearchInput value={q} onChange={setQ} placeholder="Поиск чата" />
              <div className="max-h-72 overflow-y-auto rounded-md border">
                {list.length === 0 ? (
                  <p className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
                    <Users className="size-4" /> Ничего не найдено
                  </p>
                ) : (
                  list.map((c) => {
                    const t = chatTitle(c, name);
                    const on = ids.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setIds((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))
                        }
                        className={cn(
                          "flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted",
                          on && "bg-muted",
                        )}
                      >
                        <ChatAvatar chat={c} title={t} size="sm" />
                        <span className="min-w-0 flex-1 truncate text-sm">{t}</span>
                        <span
                          className={cn(
                            "flex size-5 shrink-0 items-center justify-center rounded-full border",
                            on && "border-selected bg-selected text-selected-foreground",
                          )}
                        >
                          {on && <Check className="size-3.5" />}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}{" "}
            {folder.id ? "Сохранить" : "Создать папку"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

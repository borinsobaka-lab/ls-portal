/**
 * Поле ввода сообщения (TASKS_CHATS_PLAN.md, 3.3; бриф 2.9, 2.11, боль № 29):
 * редактор TipTap — форматирование видно сразу (жирный, курсив,
 * зачёркнутый, код, ссылка, списки, цитата), упоминания через «@» и «+»
 * (без смены раскладки), файлы — кнопкой, вставкой и перетаскиванием,
 * ответ и правка — плашкой над полем, черновик чата — в браузере. Enter —
 * отправить, Shift+Enter — новая строка (на телефоне Enter — новая строка,
 * отправка — кнопкой). Отдельный чанк: TipTap грузится только в чатах.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import {
  Bold,
  Code,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  Paperclip,
  Pencil,
  Quote,
  Reply,
  Send,
  Smile,
  Strikethrough,
  Type,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { StaffAvatar } from "@/components/employee-photo";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { docText } from "@/lib/chats/content";
import { formatFileSize, uploadChatFile } from "@/lib/chats/files";
import type { ChatAttachment, ChatDoc, ChatMessage } from "@/lib/chats/types";
import { cn } from "@/lib/utils";

export type MentionCandidate = { id: string; name: string; avatar: string | null; hint?: string };

export type ComposerSend = { content: ChatDoc | null; text: string; attachments: ChatAttachment[] };

export type ComposerHandle = {
  focus: () => void;
  insertText: (t: string) => void;
  addFiles: (f: File[]) => void;
};

type Upload = {
  key: string;
  name: string;
  size: number;
  progress: number;
  done?: ChatAttachment;
  error?: string;
};

type SuggestState = {
  items: MentionCandidate[];
  index: number;
  rect: DOMRect | null;
  command: (item: { id: string; label: string }) => void;
} | null;

const EMOJI = [
  "👍",
  "❤️",
  "😂",
  "🔥",
  "🙏",
  "👏",
  "😊",
  "🎉",
  "✅",
  "👌",
  "🤝",
  "💪",
  "😍",
  "🤔",
  "😢",
  "😮",
  "🙌",
  "⭐",
  "🚀",
  "📌",
  "💡",
  "📎",
  "⏰",
  "❗",
  "😅",
  "😉",
  "🥰",
  "😎",
  "🤗",
  "😴",
  "👀",
  "💯",
];

const isTouch = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

const draftKey = (chatId: string) => `chat-draft:${chatId}`;

function readDraft(chatId: string): ChatDoc | null {
  try {
    const raw = window.localStorage.getItem(draftKey(chatId));
    return raw ? (JSON.parse(raw) as ChatDoc) : null;
  } catch {
    return null;
  }
}

function writeDraft(chatId: string, editor: Editor) {
  try {
    if (editor.isEmpty) window.localStorage.removeItem(draftKey(chatId));
    else window.localStorage.setItem(draftKey(chatId), JSON.stringify(editor.getJSON()));
  } catch {
    // нет места или приватный режим — без черновика
  }
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    chatId: string;
    candidates: MentionCandidate[];
    replyTo: ChatMessage | null;
    editing: ChatMessage | null;
    authorName: (id: string | null) => string;
    disabledReason?: string | null;
    onCancelReply: () => void;
    onCancelEdit: () => void;
    onSend: (msg: ComposerSend) => Promise<void> | void;
    onEdit: (msg: ComposerSend) => Promise<void>;
    onTyping: () => void;
    onEditLast: () => void;
  }
>(function Composer(props, ref) {
  const {
    chatId,
    candidates,
    replyTo,
    editing,
    authorName,
    disabledReason,
    onCancelReply,
    onCancelEdit,
    onSend,
    onEdit,
    onTyping,
    onEditLast,
  } = props;
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [toolbar, setToolbar] = useState(false);
  const [suggest, setSuggest] = useState<SuggestState>(null);
  const [busy, setBusy] = useState(false);
  const suggestRef = useRef<SuggestState>(null);
  suggestRef.current = suggest;
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const sendRef = useRef<() => void>(() => {});
  const fileInput = useRef<HTMLInputElement>(null);
  const typingAt = useRef(0);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const onEditLastRef = useRef(onEditLast);
  onEditLastRef.current = onEditLast;

  const suggestion = useCallback(
    (char: string) => ({
      char,
      allowSpaces: false,
      items: ({ query }: { query: string }) => {
        const q = query.toLowerCase().replace(/ё/g, "е");
        return candidatesRef.current
          .filter((c) =>
            q === ""
              ? true
              : c.name
                  .toLowerCase()
                  .replace(/ё/g, "е")
                  .split(/\s+/)
                  .some((w) => w.startsWith(q)) ||
                c.name.toLowerCase().replace(/ё/g, "е").includes(q),
          )
          .slice(0, 8);
      },
      render: () => ({
        onStart: (p: {
          items: MentionCandidate[];
          clientRect?: (() => DOMRect | null) | null;
          command: (i: { id: string; label: string }) => void;
        }) =>
          setSuggest({
            items: p.items,
            index: 0,
            rect: p.clientRect?.() ?? null,
            command: p.command,
          }),
        onUpdate: (p: {
          items: MentionCandidate[];
          clientRect?: (() => DOMRect | null) | null;
          command: (i: { id: string; label: string }) => void;
        }) =>
          setSuggest((s) => ({
            items: p.items,
            index: Math.min(s?.index ?? 0, Math.max(p.items.length - 1, 0)),
            rect: p.clientRect?.() ?? null,
            command: p.command,
          })),
        onKeyDown: ({ event }: { event: KeyboardEvent }) => {
          const s = suggestRef.current;
          if (!s || s.items.length === 0) return false;
          if (event.key === "ArrowDown") {
            setSuggest({ ...s, index: (s.index + 1) % s.items.length });
            return true;
          }
          if (event.key === "ArrowUp") {
            setSuggest({ ...s, index: (s.index - 1 + s.items.length) % s.items.length });
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            const item = s.items[s.index];
            s.command({ id: item.id, label: item.name });
            return true;
          }
          if (event.key === "Escape") {
            setSuggest(null);
            return true;
          }
          return false;
        },
        onExit: () => setSuggest(null),
      }),
    }),
    [],
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        underline: false,
        dropcursor: false,
        trailingNode: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
      Placeholder.configure({ placeholder: "Сообщение" }),
      Mention.configure({
        HTMLAttributes: { class: "chat-mention" },
        renderText: ({ node }) => `@${node.attrs.label ?? ""}`,
        renderHTML: ({ node, options }) => [
          "span",
          { ...options.HTMLAttributes, "data-type": "mention" },
          `@${node.attrs.label ?? ""}`,
        ],
        suggestions: [suggestion("@"), suggestion("+")],
      }),
    ],
    content: readDraft(chatId) ?? "",
    editorProps: {
      attributes: {
        class:
          "chat-composer max-h-48 min-h-10 overflow-y-auto px-3 py-2.5 text-[15px] leading-snug outline-none",
        "aria-label": "Сообщение",
      },
      handleKeyDown: (_view, event) => {
        if (suggestRef.current && suggestRef.current.items.length > 0) return false;
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.ctrlKey &&
          !event.isComposing &&
          !isTouch()
        ) {
          event.preventDefault();
          sendRef.current();
          return true;
        }
        if (event.key === "ArrowUp" && !editingRef.current) {
          const ed = editorRef.current;
          if (ed?.isEmpty) {
            onEditLastRef.current();
            return true;
          }
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (files.length === 0) return false;
        addFilesRef.current(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (files.length === 0) return false;
        addFilesRef.current(files);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (!editingRef.current) writeDraft(chatId, ed);
      if (!ed.isEmpty && Date.now() - typingAt.current > 3000) {
        typingAt.current = Date.now();
        onTyping();
      }
    },
  });
  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;

  // Правка: текст сообщения в поле; отмена — черновик назад.
  useEffect(() => {
    if (!editor) return;
    if (editing) {
      editor.commands.setContent((editing.content as ChatDoc) ?? editing.text);
      editor.commands.focus("end");
    } else {
      editor.commands.setContent(readDraft(chatId) ?? "");
    }
  }, [editing, editor, chatId]);

  useEffect(() => {
    if (replyTo) editor?.commands.focus("end");
  }, [replyTo, editor]);

  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const key = crypto.randomUUID();
        setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0 }]);
        uploadChatFile(chatId, file, (share) =>
          setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: share } : x))),
        )
          .then((done) =>
            setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: 1, done } : x))),
          )
          .catch((e: Error) =>
            setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: e.message } : x))),
          );
      }
    },
    [chatId],
  );
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus("end"),
      insertText: (t: string) => editor?.chain().focus().insertContent(t).run(),
      addFiles,
    }),
    [editor, addFiles],
  );

  const uploading = uploads.some((u) => !u.done && !u.error);

  const send = useCallback(async () => {
    if (!editor || busy || disabledReason) return;
    if (uploading) {
      toast.info("Дождитесь загрузки файлов");
      return;
    }
    const json = editor.getJSON() as ChatDoc;
    const text = docText(json);
    const attachments = uploads.flatMap((u) => (u.done ? [u.done] : []));
    if (!text && attachments.length === 0) return;
    const content = text ? json : null;
    setBusy(true);
    try {
      if (editing) {
        await onEdit({ content, text, attachments: [] });
      } else {
        // Поле очищаем сразу: отправка видна в переписке, при сбое — «Повторить».
        editor.commands.clearContent();
        setUploads([]);
        try {
          window.localStorage.removeItem(draftKey(chatId));
        } catch {
          // без черновика
        }
        void Promise.resolve(onSend({ content, text, attachments })).catch(() => {});
      }
    } finally {
      setBusy(false);
      editor.commands.focus();
    }
  }, [editor, busy, disabledReason, uploading, uploads, editing, onEdit, onSend, chatId]);
  sendRef.current = () => void send();

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Адрес ссылки", prev ?? "https://");
    if (url === null) return;
    if (url.trim() === "") editor.chain().focus().extendMarkRange("link").unsetLink().run();
    else editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  const tools = editor
    ? [
        {
          icon: Bold,
          label: "Жирный (Ctrl+B)",
          active: "bold",
          run: () => editor.chain().focus().toggleBold().run(),
        },
        {
          icon: Italic,
          label: "Курсив (Ctrl+I)",
          active: "italic",
          run: () => editor.chain().focus().toggleItalic().run(),
        },
        {
          icon: Strikethrough,
          label: "Зачёркнутый",
          active: "strike",
          run: () => editor.chain().focus().toggleStrike().run(),
        },
        {
          icon: Code,
          label: "Код",
          active: "code",
          run: () => editor.chain().focus().toggleCode().run(),
        },
        { icon: Link2, label: "Ссылка", active: "link", run: setLink },
        {
          icon: List,
          label: "Список",
          active: "bulletList",
          run: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          icon: ListOrdered,
          label: "Нумерованный список",
          active: "orderedList",
          run: () => editor.chain().focus().toggleOrderedList().run(),
        },
        {
          icon: Quote,
          label: "Цитата",
          active: "blockquote",
          run: () => editor.chain().focus().toggleBlockquote().run(),
        },
      ]
    : [];

  if (disabledReason) {
    return (
      <div className="border-t bg-background px-4 py-3 text-center text-sm text-muted-foreground">
        {disabledReason}
      </div>
    );
  }

  return (
    <div className="relative border-t bg-background px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-3">
      {(replyTo || editing) && (
        <div className="mb-2 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-1.5">
          {editing ? (
            <Pencil className="size-4 shrink-0 text-brand-on-light" />
          ) : (
            <Reply className="size-4 shrink-0 text-brand-on-light" />
          )}
          <span className="min-w-0 flex-1 text-sm">
            <span className="block font-medium text-brand-on-light">
              {editing ? "Редактирование" : `Ответ: ${authorName(replyTo!.author_id)}`}
            </span>
            <span className="block truncate text-muted-foreground">
              {(editing ?? replyTo)!.text ||
                ((editing ?? replyTo)!.attachments.length ? "Файл" : "")}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Отменить"
            onClick={editing ? onCancelEdit : onCancelReply}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {uploads.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {uploads.map((u) => (
            <span
              key={u.key}
              className={cn(
                "relative flex max-w-60 items-center gap-2 overflow-hidden rounded-md border bg-background py-1 pr-1 pl-2 text-xs",
                u.error && "border-destructive text-destructive",
              )}
              title={u.error ?? u.name}
            >
              {!u.done && !u.error && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
              <span className="truncate">{u.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {u.error ? "ошибка" : formatFileSize(u.size)}
              </span>
              <button
                type="button"
                className="rounded p-0.5 hover:bg-muted"
                aria-label={`Убрать ${u.name}`}
                onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}
              >
                <X className="size-3.5" />
              </button>
              {!u.done && !u.error && (
                <span
                  className="absolute bottom-0 left-0 h-0.5 bg-brand transition-[width]"
                  style={{ width: `${Math.round(u.progress * 100)}%` }}
                />
              )}
            </span>
          ))}
        </div>
      )}

      {toolbar && editor && (
        <div className="mb-1 flex flex-wrap gap-0.5">
          {tools.map((t) => (
            <Button
              key={t.label}
              variant="ghost"
              size="icon"
              className={cn("size-8", editor.isActive(t.active) && "bg-muted")}
              aria-label={t.label}
              title={t.label}
              aria-pressed={editor.isActive(t.active)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={t.run}
            >
              <t.icon className="size-4" />
            </Button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {!editing && (
          <Button
            variant="ghost"
            size="icon"
            className="mb-0.5 size-9 shrink-0"
            aria-label="Прикрепить файлы"
            title="Прикрепить файлы"
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="size-5" />
          </Button>
        )}
        <div className="min-w-0 flex-1 rounded-2xl bg-muted/60 focus-within:bg-muted">
          <EditorContent editor={editor} />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className={cn("mb-0.5 size-9 shrink-0", toolbar && "bg-muted")}
          aria-label="Форматирование"
          title="Форматирование"
          aria-pressed={toolbar}
          onClick={() => setToolbar((v) => !v)}
        >
          <Type className="size-5" />
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="mb-0.5 size-9 shrink-0 max-sm:hidden"
              aria-label="Эмодзи"
              title="Эмодзи"
            >
              <Smile className="size-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="top"
            className="w-72 p-2"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <div className="grid grid-cols-8 gap-0.5">
              {EMOJI.map((em) => (
                <button
                  key={em}
                  type="button"
                  className="rounded p-1 text-xl hover:bg-muted"
                  onClick={() => editor?.chain().focus().insertContent(em).run()}
                >
                  {em}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Button
          size="icon"
          className="mb-0.5 size-9 shrink-0"
          aria-label={editing ? "Сохранить" : "Отправить"}
          title={editing ? "Сохранить (Enter)" : "Отправить (Enter)"}
          disabled={busy}
          onClick={() => void send()}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>

      {suggest && suggest.items.length > 0 && suggest.rect && (
        <div
          role="listbox"
          aria-label="Кого упомянуть"
          className="fixed z-50 w-72 overflow-hidden rounded-lg border bg-popover p-1 shadow-lg"
          style={{
            left: Math.min(suggest.rect.left, window.innerWidth - 296),
            bottom: window.innerHeight - suggest.rect.top + 6,
          }}
        >
          {suggest.items.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === suggest.index}
              onMouseDown={(e) => {
                e.preventDefault();
                suggest.command({ id: c.id, label: c.name });
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                i === suggest.index ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <StaffAvatar value={c.avatar} name={c.name} className="size-7 text-[10px]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{c.name}</span>
                {c.hint && (
                  <span className="block truncate text-xs text-muted-foreground">{c.hint}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default Composer;

/**
 * Поле ввода сообщения (TASKS_CHATS_PLAN.md, 3.3; бриф 2.9, 2.11, боль № 29):
 * редактор TipTap — форматирование видно сразу (жирный, курсив,
 * подчёркнутый, зачёркнутый, код, ссылка, списки, цитата), упоминания
 * через «@» и «+» (без смены раскладки), файлы — кнопкой, вставкой и перетаскиванием,
 * ответ и правка — плашкой над полем, черновик чата — в браузере. Enter —
 * отправить, Shift+Enter — новая строка (на телефоне Enter — новая строка,
 * отправка — кнопкой). Отдельный чанк: TipTap грузится только в чатах.
 *
 * Голосовые (решение владельца 2026-11-08): пока в поле нет ни одного
 * символа и файлов, вместо «Отправить» — микрофон. Нажать и держать —
 * запись, отпустить — отправить, увести палец влево — отмена, вверх —
 * «без рук» (запись идёт, кнопка становится «Отправить»). Файл грузится
 * фоном (плашка над полем, при обрыве — докачка) и уходит сам. Эмодзи —
 * весь набор с поиском (emoji-picker.tsx, отдельный чанк) — в поле справа.
 *
 * Телефон (жалоба владельца 2026-11-08: «сворачивается клавиатура, не могу
 * выделить текст»): кнопки у поля не забирают фокус (`noBlur` — касание не
 * снимает выделение и не прячет клавиатуру), панель форматирования — под
 * полем (системное меню «Вырезать / Копировать» встаёт над выделением и
 * закрывало её), шрифт поля — 16 px (иначе iPhone увеличивает страницу при
 * касании поля), «Кого упомянуть» — плашкой над полем во всю ширину.
 *
 * Проще для новичка (UI_REVIEW_CHATS_TASKS_CALENDAR.md, 3.4): с мышью
 * скрепка сразу открывает выбор файла, «Создать опрос» — своя кнопка; на
 * телефоне скрепка — меню «Фото и видео / Файл / Создать опрос». «Отправить
 * позже» — часики у «Отправить» (правая кнопка по «Отправить» — ускоритель).
 * Форматирование — и панелью над выделенным текстом (BubbleMenu TipTap, с
 * мышью), и кнопкой «Т» в поле рядом с эмодзи; ссылка — окном «Адрес / Текст».
 * Кнопки у поля на сенсорном экране — 44 px.
 */
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { Placeholder } from "@tiptap/extensions";
import {
  BarChart3,
  Bold,
  ChevronUp,
  Clock,
  Code,
  FileText,
  ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  Loader2,
  LockKeyhole,
  Mic,
  Paperclip,
  Pencil,
  Quote,
  Reply,
  RotateCw,
  Send,
  Smile,
  Strikethrough,
  Trash2,
  Type,
  Underline,
  WifiOff,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { ScheduleDialog } from "@/components/chats/chat-extras";
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
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { docText, scheduledLabel } from "@/lib/chats/content";
import { formatFileSize, startChatUpload, type ChatUpload } from "@/lib/chats/files";
import type { ChatAttachment, ChatDoc, ChatMessage } from "@/lib/chats/types";
import {
  attachmentsLabel,
  formatVoiceTime,
  holdGesture,
  VOICE_MAX_SECONDS,
  voiceFileName,
} from "@/lib/chats/voice";
import {
  canRecordVoice,
  MicUnavailable,
  startVoiceRecording,
  type VoiceRecorder,
} from "@/lib/chats/voice-recorder";
import { cn } from "@/lib/utils";

const EmojiPicker = lazy(() => import("@/components/chats/emoji-picker"));

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
  /** Связь пропала — докачаем, когда появится. */
  waiting?: boolean;
  /** Голосовое: уходит само, как только загрузится. */
  voice?: { duration: number; waveform: number[] };
};

/** Идёт запись голосового: держат кнопку или «без рук». */
type Recording = { phase: "hold" | "locked"; dx: number };

type SuggestState = {
  items: MentionCandidate[];
  index: number;
  rect: DOMRect | null;
  command: (item: { id: string; label: string }) => void;
} | null;

const isTouch = () =>
  typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;

/**
 * Кнопка у поля не забирает фокус: иначе касание на телефоне снимает
 * выделение и прячет клавиатуру (фокус уходит с поля на кнопку, а вернуть его
 * программно iPhone без нового касания не даёт — клавиатура не появится).
 */
const noBlur = { onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() };

/** Что подсвечивать в панели форматирования. */
const ACTIVE_MARKS = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "bulletList",
  "orderedList",
  "blockquote",
] as const;

/** Кнопка у поля: 36 px с мышью, 44 px на сенсорном экране (3.4.5). */
const FIELD_BUTTON = "mb-0.5 size-9 shrink-0 pointer-coarse:size-11";

/** Ссылка в поле: что выделено и какой адрес уже стоит. */
type LinkDraft = { href: string; text: string; selection: boolean };

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

/** Живая волна записи: последние уровни громкости, свежие справа. */
function LiveWave({ levels }: { levels: number[] }) {
  const bars = 28;
  const tail = levels.slice(-bars);
  const pad = Array.from({ length: bars - tail.length }, () => 0);
  return (
    <span className="flex h-6 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden>
      {[...pad, ...tail].map((v, i) => (
        <span
          key={i}
          className="w-[3px] shrink-0 rounded-full bg-red-500/70"
          style={{ height: `${Math.max(10, Math.round(v * 100))}%` }}
        />
      ))}
    </span>
  );
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    chatId: string;
    candidates: MentionCandidate[];
    replyTo: ChatMessage | null;
    editing: ChatMessage | null;
    authorName: (id: string | null) => string;
    /** Писать нельзя — текст вместо поля (может быть со ссылкой). */
    disabledReason?: React.ReactNode;
    onCancelReply: () => void;
    onCancelEdit: () => void;
    onSend: (msg: ComposerSend) => Promise<void> | void;
    onEdit: (msg: ComposerSend) => Promise<void>;
    onTyping: () => void;
    onEditLast: () => void;
    /** «Отправить позже» (этап 2, Д.6). */
    onSchedule?: (msg: ComposerSend, at: Date) => Promise<void>;
    /** «Опрос» в меню скрепки (этап 2, 2.16). */
    onPoll?: () => void;
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
    onSchedule,
    onPoll,
  } = props;
  const [attachMenu, setAttachMenu] = useState(false);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const longPress = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [toolbar, setToolbar] = useState(false);
  const [suggest, setSuggest] = useState<SuggestState>(null);
  const [busy, setBusy] = useState(false);
  const [touch] = useState(isTouch);
  const suggestRef = useRef<SuggestState>(null);
  suggestRef.current = suggest;
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const sendRef = useRef<() => void>(() => {});
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const typingAt = useRef(0);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const onEditLastRef = useRef(onEditLast);
  onEditLastRef.current = onEditLast;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [micOk, setMicOk] = useState(false);
  useEffect(() => setMicOk(canRecordVoice()), []);
  const [rec, setRec] = useState<Recording | null>(null);
  const recRef = useRef<{
    recorder: VoiceRecorder;
    x: number;
    y: number;
    phase: Recording["phase"];
    failed: boolean;
    /** Клик после жеста «вверх» — не «Отправить». */
    skipClick: boolean;
  } | null>(null);
  const [, setTick] = useState(0);

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
          // 16 px на сенсорных экранах: с меньшим шрифтом iPhone увеличивает
          // страницу при касании поля, и она остаётся увеличенной.
          "chat-composer max-h-48 min-h-10 overflow-y-auto px-3 py-2.5 text-base leading-snug outline-none pointer-fine:text-[15px]",
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
  // Пусто ли поле: «Отправить» ↔ микрофон.
  const empty = useEditorState({ editor, selector: ({ editor: ed }) => ed?.isEmpty ?? true });
  // TipTap 3 не перерисовывает компонент на каждое изменение — подсветку
  // кнопок форматирования берём подпиской на состояние редактора.
  const active = useEditorState({
    editor,
    selector: ({ editor: ed }) =>
      Object.fromEntries(ACTIVE_MARKS.map((k) => [k, ed?.isActive(k) ?? false])) as Record<
        string,
        boolean
      >,
  });

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

  // Загрузки по ключу: «Повторить», убрать файл, уход из чата.
  const handles = useRef(new Map<string, ChatUpload>());
  useEffect(() => {
    const map = handles.current;
    // Ушли из чата — останавливаем, но не стираем: тот же файл здесь докачается.
    return () => map.forEach((h) => h.cancel(false));
  }, []);

  const upload = useCallback(
    (file: File, voice?: Upload["voice"]) => {
      const key = crypto.randomUUID();
      const patch = (p: Partial<Upload>) =>
        setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));
      setUploads((u) => [...u, { key, name: file.name, size: file.size, progress: 0, voice }]);
      const handle = startChatUpload(chatId, file, (s) => {
        if (s.status === "uploading")
          patch({ progress: s.share, waiting: false, error: undefined });
        else if (s.status === "waiting") patch({ progress: s.share, waiting: true });
        else if (s.status === "done") {
          handles.current.delete(key);
          if (voice) {
            // Голосовое уходит само — отдельным сообщением.
            setUploads((u) => u.filter((x) => x.key !== key));
            void Promise.resolve(
              onSendRef.current({
                content: null,
                text: "",
                attachments: [{ ...s.attachment, voice: true, ...voice }],
              }),
            ).catch(() => {});
          } else patch({ progress: 1, done: s.attachment, waiting: false, error: undefined });
        } else patch({ error: s.message, waiting: false });
      });
      handles.current.set(key, handle);
    },
    [chatId],
  );
  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) upload(file);
    },
    [upload],
  );
  const removeUpload = useCallback((key: string) => {
    handles.current.get(key)?.cancel();
    handles.current.delete(key);
    setUploads((list) => list.filter((x) => x.key !== key));
  }, []);
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

  // Голосовые грузятся и уходят сами — отправку текста не держат.
  const files = uploads.filter((u) => !u.voice);
  const uploading = files.some((u) => !u.done && !u.error);
  const stalled = files.some((u) => u.error || u.waiting);

  /** Что отправить: текст и загруженные файлы; null — нечего или файлы не готовы. */
  const collect = useCallback((): ComposerSend | null => {
    if (!editor) return null;
    if (uploading || stalled) {
      toast.info(
        stalled
          ? "Не все файлы загрузились — дождитесь связи, нажмите «Повторить» или уберите файл"
          : "Дождитесь загрузки файлов",
      );
      return null;
    }
    const json = editor.getJSON() as ChatDoc;
    const text = docText(json);
    const attachments = files.flatMap((u) => (u.done ? [u.done] : []));
    if (!text && attachments.length === 0) return null;
    return { content: text ? json : null, text, attachments };
  }, [editor, uploading, stalled, files]);

  const clearDraft = useCallback(() => {
    editor?.commands.clearContent();
    setUploads((u) => u.filter((x) => x.voice));
    try {
      window.localStorage.removeItem(draftKey(chatId));
    } catch {
      // без черновика
    }
  }, [editor, chatId]);

  const openSchedule = () => {
    if (!onSchedule || editing || disabledReason) return;
    if (!collect()) {
      if (!uploading && !stalled)
        toast.info("Напишите сообщение — потом выберите, когда отправить");
      return;
    }
    setScheduling(true);
  };

  const send = useCallback(async () => {
    if (!editor || busy || disabledReason) return;
    const msg = collect();
    if (!msg) return;
    const { content, text, attachments } = msg;
    // Фокус возвращаем, только если он был в поле: на телефоне иначе
    // отправка кнопкой при спрятанной клавиатуре снова её открывала бы.
    const keepFocus = editor.isFocused || !isTouch();
    setBusy(true);
    try {
      if (editing) {
        await onEdit({ content, text, attachments: [] });
      } else {
        // Поле очищаем сразу: отправка видна в переписке, при сбое — «Повторить».
        editor.commands.clearContent();
        setUploads((u) => u.filter((x) => x.voice));
        try {
          window.localStorage.removeItem(draftKey(chatId));
        } catch {
          // без черновика
        }
        void Promise.resolve(onSend({ content, text, attachments })).catch(() => {});
      }
    } finally {
      setBusy(false);
      if (keepFocus) editor.commands.focus();
    }
  }, [editor, busy, disabledReason, collect, editing, onEdit, onSend, chatId]);
  sendRef.current = () => void send();

  // ——— Голосовое ———
  const finishVoice = useCallback(
    async (send: boolean) => {
      const r = recRef.current;
      if (!r) return;
      recRef.current = null;
      setRec(null);
      if (!send) {
        r.recorder.cancel();
        return;
      }
      const out = await r.recorder.stop();
      if (!out) {
        if (!r.failed)
          toast.info("Удерживайте микрофон, пока говорите — отпустите, чтобы отправить");
        return;
      }
      const file = new File([out.blob], voiceFileName(new Date(), out.mime), { type: out.mime });
      upload(file, { duration: out.duration, waveform: out.waveform });
    },
    [upload],
  );

  // Время и живая волна, предел длины, Esc — отмена.
  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => {
      setTick((n) => n + 1);
      if ((recRef.current?.recorder.elapsed() ?? 0) >= VOICE_MAX_SECONDS) void finishVoice(true);
    }, 100);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void finishVoice(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [rec, finishVoice]);
  // Ушли из чата посреди записи — микрофон выключаем.
  useEffect(() => () => recRef.current?.recorder.cancel(), []);

  const micDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || recRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const recorder = startVoiceRecording();
    const r = {
      recorder,
      x: e.clientX,
      y: e.clientY,
      phase: "hold" as const,
      failed: false,
      skipClick: false,
    };
    recRef.current = r;
    setRec({ phase: "hold", dx: 0 });
    recorder.ready.then(
      () => navigator.vibrate?.(15),
      (err: unknown) => {
        r.failed = true;
        if (recRef.current === r) {
          recRef.current = null;
          setRec(null);
        }
        toast.error(err instanceof MicUnavailable ? err.message : "Не удалось включить микрофон");
      },
    );
  };
  const micMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const r = recRef.current;
    if (!r || r.phase !== "hold") return;
    const dx = e.clientX - r.x;
    const g = holdGesture(dx, e.clientY - r.y);
    if (g === "cancel") {
      navigator.vibrate?.(30);
      void finishVoice(false);
    } else if (g === "lock") {
      r.phase = "locked";
      r.skipClick = true;
      setRec({ phase: "locked", dx: 0 });
    } else setRec((v) => (v && v.phase === "hold" ? { ...v, dx: Math.min(0, dx) } : v));
  };
  const micUp = () => {
    if (recRef.current?.phase === "hold") void finishVoice(true);
  };
  const micClick = () => {
    const r = recRef.current;
    if (!r || r.phase !== "locked") return;
    if (r.skipClick) {
      r.skipClick = false;
      return;
    }
    void finishVoice(true);
  };

  const pickEmoji = (em: string) => {
    if (!editor) return;
    // Без фокуса: на телефоне иначе выскакивает клавиатура поверх окна эмодзи.
    editor.chain().insertContent(em).run();
  };

  // Ссылка — окном портала с «Адрес» и «Текст» (вместо window.prompt, 3.4.3).
  const setLink = () => {
    if (!editor) return;
    if (editor.isActive("link")) editor.chain().extendMarkRange("link").run();
    const { from, to } = editor.state.selection;
    setLinkDraft({
      href: (editor.getAttributes("link").href as string | undefined) ?? "",
      text: editor.state.doc.textBetween(from, to, " "),
      selection: from !== to,
    });
  };
  const applyLink = (href: string, text: string) => {
    if (!editor || !linkDraft) return;
    const chain = editor.chain().focus();
    if (!href) {
      chain.extendMarkRange("link").unsetLink().run();
      return;
    }
    const url = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
    if (linkDraft.selection && text === linkDraft.text)
      chain.extendMarkRange("link").setLink({ href: url }).run();
    else
      chain
        .insertContent({
          type: "text",
          text: text || url,
          marks: [{ type: "link", attrs: { href: url } }],
        })
        .unsetMark("link")
        .insertContent(" ")
        .run();
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
          icon: Underline,
          label: "Подчёркнутый (Ctrl+U)",
          active: "underline",
          run: () => editor.chain().focus().toggleUnderline().run(),
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

  const toolButton = (t: (typeof tools)[number], big: boolean) => (
    <Button
      key={t.label}
      variant="ghost"
      size="icon"
      className={cn(
        "size-8 shrink-0",
        big && "pointer-coarse:size-10",
        active?.[t.active] && "bg-muted text-chat-accent",
      )}
      aria-label={t.label}
      title={t.label}
      aria-pressed={!!active?.[t.active]}
      {...noBlur}
      onClick={t.run}
    >
      <t.icon className={cn("size-4", big && "pointer-coarse:size-5")} />
    </Button>
  );

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
            <Pencil className="size-4 shrink-0 text-chat-accent" />
          ) : (
            <Reply className="size-4 shrink-0 text-chat-accent" />
          )}
          <span className="min-w-0 flex-1 text-sm">
            <span className="block font-medium text-chat-accent">
              {editing ? "Редактирование" : `Ответ: ${authorName(replyTo!.author_id)}`}
            </span>
            <span className="block truncate text-muted-foreground">
              {(editing ?? replyTo)!.text || attachmentsLabel((editing ?? replyTo)!.attachments)}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={editing ? "Отменить правку" : "Отменить ответ"}
            title={editing ? "Отменить правку" : "Отменить ответ"}
            {...noBlur}
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
                "relative flex max-w-64 items-center gap-2 overflow-hidden rounded-md border bg-background py-1 pr-1 pl-2 text-xs",
                u.error && "border-destructive text-destructive",
              )}
              title={
                u.error ?? (u.waiting ? `${u.name}: нет связи — докачаем, когда появится` : u.name)
              }
            >
              {u.waiting ? (
                <WifiOff className="size-3.5 shrink-0 text-amber-600" />
              ) : (
                !u.done && !u.error && <Loader2 className="size-3.5 shrink-0 animate-spin" />
              )}
              {u.voice && <Mic className="size-3.5 shrink-0 text-chat-accent" />}
              {u.error && <span className="sr-only">Ошибка: {u.error}</span>}
              <span className="truncate">
                {u.voice ? `Голосовое ${formatVoiceTime(u.voice.duration)}` : u.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {u.error
                  ? "ошибка"
                  : u.waiting
                    ? `${Math.round(u.progress * 100)}% · нет связи`
                    : u.voice
                      ? "отправка…"
                      : !u.done && u.size > 6 * 1024 * 1024
                        ? `${Math.round(u.progress * 100)}% из ${formatFileSize(u.size)}`
                        : formatFileSize(u.size)}
              </span>
              {(u.waiting || (u.voice && u.error)) && (
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-muted"
                  aria-label={`Повторить ${u.name}`}
                  title="Повторить"
                  {...noBlur}
                  onClick={() => handles.current.get(u.key)?.resume()}
                >
                  <RotateCw className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                className="rounded p-0.5 hover:bg-muted"
                aria-label={`Убрать ${u.name}`}
                title="Убрать файл"
                {...noBlur}
                onClick={() => removeUpload(u.key)}
              >
                <X className="size-3.5" />
              </button>
              {!u.done && !u.error && (
                <span
                  className={cn(
                    "absolute bottom-0 left-0 h-0.5 transition-[width]",
                    u.waiting ? "bg-amber-500" : "bg-chat-accent",
                  )}
                  style={{ width: `${Math.round(u.progress * 100)}%` }}
                />
              )}
            </span>
          ))}
          {/* Текст ошибки — виден под файлами, не только в подсказке (3.4.6). */}
          {uploads
            .filter((u) => u.error)
            .map((u) => (
              <p key={`${u.key}-error`} className="w-full text-xs text-destructive">
                {u.voice ? "Голосовое" : u.name}: {u.error}
              </p>
            ))}
        </div>
      )}

      {/* С мышью — панель над выделенным текстом (3.4.2). */}
      {editor && !touch && (
        <BubbleMenu
          editor={editor}
          appendTo={() => document.body}
          options={{ strategy: "fixed", placement: "top" }}
          shouldShow={({ from, to }) => from !== to}
          className="z-50 flex gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md"
        >
          {tools.slice(0, 6).map((t) => toolButton(t, false))}
        </BubbleMenu>
      )}

      {/*
        Панель форматирования: с мышью — над полем, на сенсорном экране — под
        ним, одной строкой с прокруткой и кнопками крупнее: системное меню
        выделения («Вырезать / Копировать») встаёт над выделенным текстом и
        закрывало панель над полем.
      */}
      <div className="flex flex-col">
        {toolbar && editor && (
          <div
            role="toolbar"
            aria-label="Форматирование"
            className="mb-1 flex flex-wrap gap-0.5 pointer-coarse:order-last pointer-coarse:mt-1 pointer-coarse:mb-0 pointer-coarse:flex-nowrap pointer-coarse:overflow-x-auto pointer-coarse:[scrollbar-width:none]"
          >
            {tools.map((t) => toolButton(t, true))}
          </div>
        )}

        <div className="relative flex items-end gap-1">
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
          <input
            ref={mediaInput}
            type="file"
            multiple
            hidden
            accept="image/*,video/*"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          {rec && (
            <div
              className="mb-0.5 flex h-10 min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-2xl bg-border/70 pr-1 pl-3.5"
              role="status"
              aria-live="polite"
            >
              <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
              <span className="shrink-0 text-sm tabular-nums">
                {formatVoiceTime(recRef.current?.recorder.elapsed() ?? 0)}
              </span>
              <LiveWave levels={recRef.current?.recorder.levels() ?? []} />
              {rec.phase === "hold" ? (
                <span
                  className="ml-auto shrink-0 truncate pr-2 text-sm text-muted-foreground transition-transform"
                  style={{ transform: `translateX(${rec.dx / 2}px)`, opacity: 1 + rec.dx / 120 }}
                >
                  ‹ Влево — отмена
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto shrink-0 text-destructive hover:text-destructive"
                  {...noBlur}
                  onClick={() => void finishVoice(false)}
                >
                  <Trash2 className="size-4" /> Отмена
                </Button>
              )}
            </div>
          )}
          {!editing &&
            !rec &&
            (touch ? (
              // Телефон: «Фото и видео», «Файл», «Создать опрос» (как Telegram).
              <Popover open={attachMenu} onOpenChange={setAttachMenu}>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={FIELD_BUTTON}
                    aria-label="Прикрепить"
                    title="Прикрепить"
                    {...noBlur}
                  >
                    <Paperclip className="size-5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  className="w-56 p-1"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                >
                  {(
                    [
                      ["Фото и видео", ImageIcon, () => mediaInput.current?.click()],
                      ["Файл", FileText, () => fileInput.current?.click()],
                      ...(onPoll ? ([["Создать опрос", BarChart3, onPoll]] as const) : []),
                    ] as const
                  ).map(([label, Icon, run]) => (
                    <ListItemButton
                      key={label}
                      className="py-2"
                      onClick={() => {
                        setAttachMenu(false);
                        run();
                      }}
                    >
                      <Icon /> {label}
                    </ListItemButton>
                  ))}
                </PopoverContent>
              </Popover>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className={FIELD_BUTTON}
                  aria-label="Прикрепить файл"
                  title="Прикрепить файл"
                  {...noBlur}
                  onClick={() => fileInput.current?.click()}
                >
                  <Paperclip className="size-5" />
                </Button>
                {onPoll && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={FIELD_BUTTON}
                    aria-label="Создать опрос"
                    title="Создать опрос"
                    {...noBlur}
                    onClick={onPoll}
                  >
                    <BarChart3 className="size-5" />
                  </Button>
                )}
              </>
            ))}
          {/* Поле — на ступень темнее muted (решение владельца 2026-11-08: на белом
              плохо видно); в фокусе — ещё чуть темнее. Эмодзи — в поле справа.
              Во время записи поле скрыто, но не размонтировано (TipTap). */}
          <div
            className={cn(
              "flex min-w-0 flex-1 items-end rounded-2xl bg-border/70 focus-within:bg-border",
              rec && "hidden",
            )}
          >
            <div className="min-w-0 flex-1">
              <EditorContent editor={editor} />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "mb-0.5 size-9 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground pointer-coarse:size-11",
                toolbar && "text-foreground",
              )}
              aria-label="Форматирование"
              title="Форматирование"
              aria-pressed={toolbar}
              {...noBlur}
              onClick={() => setToolbar((v) => !v)}
            >
              <Type className="size-5" />
            </Button>
            <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-0.5 mb-0.5 size-9 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground pointer-coarse:size-11"
                  aria-label="Эмодзи"
                  title="Эмодзи"
                  {...noBlur}
                >
                  <Smile className="size-5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                className="w-[min(22rem,calc(100vw-1rem))] p-0"
                onOpenAutoFocus={(e) => e.preventDefault()}
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  if (!touch) editor?.commands.focus();
                }}
              >
                <Suspense
                  fallback={
                    <div className="flex h-[min(380px,60dvh)] items-center justify-center">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  }
                >
                  <EmojiPicker onPick={pickEmoji} autoFocus={!touch} />
                </Suspense>
              </PopoverContent>
            </Popover>
          </div>
          {/* «Отправить позже» — видимые часики, когда есть что отправить (3.4.1). */}
          {!rec && onSchedule && !editing && !(empty && files.length === 0) && (
            <Button
              variant="ghost"
              size="icon"
              className={cn(FIELD_BUTTON, "text-muted-foreground")}
              aria-label="Отправить позже"
              title="Отправить позже"
              {...noBlur}
              onClick={openSchedule}
            >
              <Clock className="size-5" />
            </Button>
          )}
          {rec || (micOk && !editing && empty && files.length === 0 && !busy) ? (
            <>
              {rec?.phase === "hold" && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute right-0 bottom-full mb-3 flex w-9 flex-col items-center gap-0.5 rounded-full border bg-background py-2 text-muted-foreground shadow-sm"
                >
                  <LockKeyhole className="size-4" />
                  <ChevronUp className="size-4 animate-bounce" />
                </span>
              )}
              <Button
                size="icon"
                className={cn(
                  "mb-0.5 size-9 shrink-0 touch-none rounded-full select-none [-webkit-touch-callout:none] pointer-coarse:size-11",
                  rec?.phase === "hold"
                    ? "scale-125 bg-red-500 text-white hover:bg-red-500"
                    : "bg-selected text-selected-foreground hover:bg-selected/90",
                )}
                aria-label={rec?.phase === "locked" ? "Отправить голосовое" : "Записать голосовое"}
                title={
                  rec?.phase === "locked"
                    ? "Отправить голосовое"
                    : "Записать голосовое (удерживайте)"
                }
                {...noBlur}
                onPointerDown={micDown}
                onPointerMove={micMove}
                onPointerUp={micUp}
                onPointerCancel={() => {
                  if (recRef.current?.phase === "hold") void finishVoice(false);
                }}
                onContextMenu={(e) => e.preventDefault()}
                onClick={micClick}
              >
                {rec?.phase === "locked" ? <Send className="size-4" /> : <Mic className="size-5" />}
              </Button>
            </>
          ) : (
            <Button
              size="icon"
              className="mb-0.5 size-9 shrink-0 rounded-full bg-selected text-selected-foreground hover:bg-selected/90 pointer-coarse:size-11"
              aria-label={editing ? "Сохранить" : "Отправить"}
              title={editing ? "Сохранить (Enter)" : "Отправить (Enter)"}
              disabled={busy}
              {...noBlur}
              onContextMenu={(e) => {
                if (editing || !onSchedule) return;
                e.preventDefault();
                openSchedule();
              }}
              onTouchStart={() => {
                if (editing || !onSchedule) return;
                longPress.current.fired = false;
                longPress.current.timer = window.setTimeout(() => {
                  longPress.current.fired = true;
                  openSchedule();
                }, 550);
              }}
              onTouchEnd={() => {
                if (longPress.current.timer) window.clearTimeout(longPress.current.timer);
                longPress.current.timer = null;
              }}
              onClick={() => {
                if (longPress.current.fired) {
                  longPress.current.fired = false;
                  return;
                }
                void send();
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          )}
        </div>
      </div>

      {onSchedule && (
        <ScheduleDialog
          open={scheduling}
          onClose={() => setScheduling(false)}
          onPick={async (at) => {
            const msg = collect();
            if (!msg) throw new Error("Нечего отправлять");
            await onSchedule(msg, at);
            clearDraft();
            toast.success(`Запланировано: ${scheduledLabel(at.toISOString(), new Date())}`);
          }}
        />
      )}
      {suggest && suggest.items.length > 0 && (suggest.rect || touch) && (
        // С мышью — у курсора; на телефоне — плашкой над полем во всю ширину:
        // координаты курсора при открытой клавиатуре iPhone ненадёжны, а
        // строки нужны крупнее пальца.
        <div
          role="listbox"
          aria-label="Кого упомянуть"
          className={cn(
            "z-50 overflow-y-auto rounded-lg border bg-popover p-1 shadow-lg",
            touch ? "absolute inset-x-2 bottom-full mb-1 max-h-[40vh]" : "fixed w-72",
          )}
          style={
            touch || !suggest.rect
              ? undefined
              : {
                  left: Math.max(8, Math.min(suggest.rect.left, window.innerWidth - 296)),
                  top: suggest.rect.top - 6,
                  transform: "translateY(-100%)",
                }
          }
        >
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
            Кого упомянуть: наберите @ или + и имя
          </p>
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
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm pointer-coarse:py-2",
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
      <Dialog open={!!linkDraft} onOpenChange={(o) => !o && setLinkDraft(null)}>
        <DialogContent className="sm:max-w-md">
          {linkDraft && (
            <LinkForm
              draft={linkDraft}
              onClose={() => setLinkDraft(null)}
              onApply={(href, text) => {
                setLinkDraft(null);
                applyLink(href, text);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
});

/** Окно ссылки: адрес и текст (пусто в адресе — убрать ссылку). */
function LinkForm({
  draft,
  onClose,
  onApply,
}: {
  draft: LinkDraft;
  onClose: () => void;
  onApply: (href: string, text: string) => void;
}) {
  const [href, setHref] = useState(draft.href);
  const [text, setText] = useState(draft.text);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{draft.href ? "Изменить ссылку" : "Ссылка"}</DialogTitle>
        <DialogDescription>
          {draft.href
            ? "Сотрите адрес, чтобы убрать ссылку."
            : "Адрес сайта или документа и текст, который увидят в сообщении."}
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={() => onApply(href.trim(), text.trim())}>
        <DialogBody className="space-y-4">
          <FormField label="Адрес">
            <Input
              autoFocus
              inputMode="url"
              placeholder="https://"
              value={href}
              onChange={(e) => setHref(e.target.value)}
            />
          </FormField>
          <FormField label="Текст" optional hint="Пусто — в сообщении будет сам адрес">
            <Input value={text} onChange={(e) => setText(e.target.value)} />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit">{draft.href && !href.trim() ? "Убрать ссылку" : "Готово"}</Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

export default Composer;

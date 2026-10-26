import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { Cat, Database, Loader2, Mic, Send, Square } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { ChoiceCard } from "@/components/ui/choice-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ClientNameLink } from "@/components/client-name-link";
import { supabase } from "@/integrations/supabase/client";
import { activeStudioHeaders } from "@/hooks/use-active-studio";
import { fromStored, MAX_QUESTION_CHARS } from "@/lib/assistant/history";
import { KATE_QUESTIONS } from "@/lib/assistant/questions";
import { unwrap } from "@/lib/query";
import { toast } from "sonner";
/**
 * Переписка сотрудника с Kate — одна на сотрудника (решение владельца
 * 2026-10-20): вся хронология в одном чате, новых чатов нет. Сообщения
 * (assistant_messages, RLS — только свои) пишет сервер (/api/chat), окно их
 * только читает: последние PAGE при открытии, раньше — по «Показать более
 * ранние».
 */
const PAGE = 100;

type Page = { messages: UIMessage[]; oldest: string | null; hasMore: boolean };

async function loadMessages(before?: string | null): Promise<Page> {
  let q = supabase
    .from("assistant_messages")
    .select("id, role, parts, created_at")
    .order("created_at", { ascending: false })
    .limit(PAGE);
  if (before) q = q.lt("created_at", before);
  const rows = await unwrap<{ id: string; role: string; parts: unknown; created_at: string }[]>(q);
  return {
    messages: rows
      .reverse()
      .map(fromStored)
      .filter((m): m is UIMessage => !!m),
    oldest: rows[0]?.created_at ?? null,
    hasMore: rows.length === PAGE,
  };
}

export function KateChat({
  heightClass = "h-[calc(100dvh-8rem)]",
  fullscreenOnMobile = false,
}: {
  heightClass?: string;
  /** Окно во весь экран на телефоне: без скруглений и рамки, место под крестик. */
  fullscreenOnMobile?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const history = useQuery({
    queryKey: ["assistant_messages"],
    queryFn: () => loadMessages(),
    // Сообщения живут в useChat; при каждом открытии окна — свежие из базы.
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    meta: { errorMessage: "Не удалось загрузить переписку с Kate" },
  });

  return (
    <div
      className={`relative isolate mx-auto ${heightClass} w-full max-w-3xl lg:max-w-5xl rounded-lg ${busy ? "ai-thinking-glow" : ""}`}
    >
      <div
        className={`relative z-10 flex h-full flex-col overflow-hidden rounded-lg border bg-background ${fullscreenOnMobile ? "max-md:rounded-none max-md:border-0" : ""}`}
      >
        {history.isPending ? (
          <ChatSkeleton />
        ) : (
          // Историю не загрузить — всё равно можно спросить.
          <ChatSession
            initial={history.data ?? { messages: [], oldest: null, hasMore: false }}
            onBusyChange={setBusy}
            fullscreenOnMobile={fullscreenOnMobile}
          />
        )}
      </div>
    </div>
  );
}

function ChatSkeleton() {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 space-y-4 overflow-hidden p-4 sm:p-6">
          <div className="flex justify-end">
            <Skeleton className="h-10 w-2/5 rounded-lg" />
          </div>
          <div className="flex justify-start">
            <Skeleton className="h-24 w-3/4 rounded-lg" />
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-10 w-1/3 rounded-lg" />
          </div>
        </div>
        <div className="flex gap-2 border-t p-3">
          <Skeleton className="h-20 flex-1" />
          <Skeleton className="h-20 w-10" />
        </div>
      </div>
      <div className="hidden w-64 shrink-0 space-y-2 border-l p-3 lg:block">
        <Skeleton className="h-4 w-32" />
        {KATE_QUESTIONS.map((q) => (
          <Skeleton key={q} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/**
 * Готовые вопросы: колонка справа от переписки, на узком экране — лента над
 * полем ввода. Пока Kate отвечает, не нажимаются.
 */
function QuickQuestions({
  layout,
  disabled,
  onAsk,
}: {
  layout: "column" | "row";
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  if (layout === "row") {
    return (
      <div className="flex gap-2 overflow-x-auto border-t px-3 pt-3 lg:hidden">
        {KATE_QUESTIONS.map((q) => (
          <ChoiceCard
            key={q}
            compact
            disabled={disabled}
            onClick={() => onAsk(q)}
            className="w-auto shrink-0 whitespace-nowrap"
          >
            {q}
          </ChoiceCard>
        ))}
      </div>
    );
  }
  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-2 overflow-y-auto border-l p-3 lg:flex">
      <p className="px-1 text-xs font-medium text-muted-foreground">Быстрые вопросы</p>
      {KATE_QUESTIONS.map((q) => (
        <ChoiceCard key={q} compact disabled={disabled} onClick={() => onAsk(q)}>
          {q}
        </ChoiceCard>
      ))}
    </aside>
  );
}

function ChatSession({
  initial,
  onBusyChange,
  fullscreenOnMobile,
}: {
  initial: Page;
  onBusyChange: (busy: boolean) => void;
  fullscreenOnMobile: boolean;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [older, setOlder] = useState({ oldest: initial.oldest, hasMore: initial.hasMore });
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Высота ленты до подгрузки ранних сообщений: после неё лента остаётся на
  // том же месте, а не прыгает вниз.
  const keepFromBottom = useRef<number | null>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        // Историю сервер берёт из базы — отправляем только новый вопрос.
        prepareSendMessagesRequest: ({ messages }) => ({
          body: { message: messages[messages.length - 1] },
        }),
        fetch: async (url, init) => {
          const { data } = await supabase.auth.getSession();
          const token = data.session?.access_token;
          const headers = new Headers(init?.headers);
          if (token) headers.set("Authorization", `Bearer ${token}`);
          for (const [k, v] of Object.entries(activeStudioHeaders())) headers.set(k, v);
          const response = await fetch(url, { ...init, headers });
          if (response.ok) return response;

          const contentType = response.headers.get("content-type") ?? "";
          const body = await response
            .clone()
            .text()
            .catch(() => "");
          const isHtmlError =
            contentType.includes("text/html") || body.trimStart().startsWith("<!doctype");
          return new Response(
            isHtmlError ? "Сервис ассистента временно недоступен. Попробуйте ещё раз." : body,
            { status: response.status, headers: { "Content-Type": "text/plain; charset=utf-8" } },
          );
        },
      }),
    [],
  );

  const { messages, setMessages, sendMessage, status, error } = useChat({
    id: "kate",
    messages: initial.messages,
    transport,
    // Ошибку показывает строка в ленте (ниже) — тост дублировал её.
  });

  const isLoading = status === "submitted" || status === "streaming";
  // Для скринридера — одна фраза о готовом ответе. Живой областью была вся
  // лента, и потоковый ответ зачитывался заново на каждом кусочке.
  const [announce, setAnnounce] = useState("");
  const wasLoading = useRef(false);
  useEffect(() => {
    if (isLoading) setAnnounce("Kate отвечает…");
    else if (wasLoading.current) setAnnounce(error ? "Kate не ответила" : "Kate ответила");
    wasLoading.current = isLoading;
  }, [isLoading, error]);
  useEffect(() => onBusyChange(isLoading), [isLoading, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
      return;
    }
    // Далеко от низа (открыли окно, листали ранние) — сразу, рядом — плавно.
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 2;
    el.scrollTo({ top: el.scrollHeight, behavior: far ? "auto" : "smooth" });
  }, [messages, status]);

  const loadOlder = async () => {
    if (loadingOlder || !older.oldest) return;
    setLoadingOlder(true);
    try {
      const page = await loadMessages(older.oldest);
      const el = scrollRef.current;
      if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
      setMessages((current) => [...page.messages, ...current]);
      setOlder({ oldest: page.oldest, hasMore: page.hasMore });
    } catch (err) {
      toast.error(
        "Не удалось загрузить ранние сообщения: " +
          (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  const sendText = async (text: string) => {
    try {
      await sendMessage({ text });
    } catch (err) {
      console.error("[assistant] send failed", err);
    }
  };

  const submit = () => {
    const text = input.trim();
    if (!text || isLoading) return;
    if (text.length > MAX_QUESTION_CHARS) {
      toast.error(`Вопрос длиннее ${MAX_QUESTION_CHARS} символов — сократите его`);
      return;
    }
    setInput("");
    void sendText(text);
  };

  const ask = (question: string) => {
    if (!isLoading) void sendText(question);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          role="region"
          aria-label="Переписка с Kate"
          className={`flex-1 space-y-4 overflow-y-auto p-4 sm:p-6 ${fullscreenOnMobile ? "max-md:pt-14" : ""}`}
        >
          {older.hasMore && (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder && <Loader2 className="animate-spin" />} Показать более ранние
              </Button>
            </div>
          )}
          {messages.length === 0 && !older.hasMore && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <div className="ai-gradient flex h-14 w-14 items-center justify-center rounded-full text-white">
                <Cat className="h-7 w-7" />
              </div>
              <div>
                <p className="text-base font-medium text-foreground">Привет! Я Kate.</p>
                <p className="mt-1 text-sm">
                  Подскажу, кому позвонить и что предложить: продления, пробные, должники, новые
                  клиенты в приложении. Выберите готовый вопрос или напишите свой.
                </p>
              </div>
            </div>
          )}
          {messages.map((m: UIMessage) => (
            <MessageBubble key={m.id} message={m} />
          ))}
          {/* Пока ответ уже печатается, «думает» лишнее. */}
          {status === "submitted" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Kate думает…
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {formatAssistantError(error)}
            </div>
          )}
          <div aria-live="polite" className="sr-only">
            {announce}
          </div>
        </div>
        <QuickQuestions layout="row" disabled={isLoading} onAsk={ask} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          // До lg над формой — лента вопросов со своей линией сверху.
          className="border-t p-3 max-lg:border-t-0"
        >
          <div className="flex items-start gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Напишите вопрос Kate…"
              rows={2}
              className="min-h-[80px] resize-none flex-1"
            />
            <div className="flex h-[80px] items-center gap-2">
              <VoiceInputButton
                disabled={isLoading}
                onTranscribed={(text) =>
                  setInput((prev) => (prev ? `${prev} ${text}` : text).trim())
                }
              />
              <Button
                type="submit"
                disabled={isLoading || !input.trim()}
                size="icon"
                aria-label="Отправить"
              >
                <Send />
              </Button>
            </div>
          </div>
        </form>
      </div>
      <QuickQuestions layout="column" disabled={isLoading} onAsk={ask} />
    </div>
  );
}

function formatAssistantError(error: Error) {
  const message = error.message.trim();
  if (!message || message.startsWith("<!doctype") || message.includes("Страница не загрузилась")) {
    return "Сервис ассистента временно недоступен. Попробуйте ещё раз.";
  }
  return message;
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";
  const text = message.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  // Идёт запрос к данным: последняя часть — вызов инструмента без текста после.
  const last = message.parts[message.parts.length - 1];
  const fetching = !isUser && !!last?.type?.startsWith("tool-");
  if (!isUser && !text && !fetching) return null;

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`min-w-0 rounded-lg px-4 py-2 text-sm ${
          isUser
            ? "max-w-[85%] bg-primary text-primary-foreground"
            : // Ответ с таблицей на телефоне — во всю ширину.
              "max-w-full bg-muted text-foreground md:max-w-[85%]"
        }`}
      >
        {fetching && (
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Database className="size-3.5" /> запрос к данным…
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap">{text}</div>
        ) : (
          <div className="prose prose-sm max-w-none prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-pre:my-2 prose-table:my-0 prose-code:before:content-none prose-code:after:content-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              disallowedElements={MARKDOWN_DISALLOWED}
              components={MARKDOWN_COMPONENTS}
              urlTransform={markdownUrl}
            >
              {text}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ссылка на карточку клиента в ответе Kate: `[Фамилия Имя](client:<uuid>)`. */
const CLIENT_LINK_RE = /^client:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Своя схема client: проходит как есть, остальное — стандартная очистка. */
function markdownUrl(url: string) {
  return CLIENT_LINK_RE.test(url) ? url : defaultUrlTransform(url);
}

/**
 * Ответ модели — недоверенный текст: в него может попасть инъекция из данных
 * (имена, заметки клиентов). Картинки не рендерим — браузер сам загрузил бы
 * URL и унёс бы в его параметрах данные из чата; ссылки открываются только
 * по клику, в новой вкладке и без Referer/opener. Ссылка client: открывает
 * карточку клиента — RLS отдаст её, только если сотруднику она видна.
 */
const MARKDOWN_DISALLOWED = ["img"];
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const client = href ? CLIENT_LINK_RE.exec(href) : null;
    if (client) {
      return (
        <ClientNameLink clientId={client[1]} className="whitespace-normal">
          {children}
        </ClientNameLink>
      );
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // Широкая таблица прокручивается внутри сообщения, а не раздвигает окно.
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="my-0">{children}</table>
    </div>
  ),
};

/** Выключает микрофон: пока дорожки потока живы, браузер держит его занятым. */
function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

function VoiceInputButton({
  disabled,
  onTranscribed,
}: {
  disabled?: boolean;
  onTranscribed: (text: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(false);

  // Окно Kate могут закрыть посреди записи: без этого запись продолжалась, а
  // микрофон оставался включённым, пока не закроют вкладку.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        // Недописанную запись на распознавание не отправляем.
        rec.onstop = null;
        rec.stop();
      }
      stopTracks(streamRef.current);
      streamRef.current = null;
    };
  }, []);

  const start = async () => {
    if (disabled || busy) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error("Нужен доступ к микрофону");
      return;
    }
    // Окно закрыли, пока браузер спрашивал доступ, — микрофон сразу гасим.
    if (!mountedRef.current) {
      stopTracks(stream);
      return;
    }
    const mimeType = ["audio/webm", "audio/mp4"].find(
      (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
    );
    if (!mimeType) {
      stopTracks(stream);
      toast.error("Браузер не поддерживает запись аудио");
      return;
    }
    const rec = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      stopTracks(stream);
      streamRef.current = null;
      const blob = new Blob(chunksRef.current, { type: rec.mimeType });
      if (blob.size < 1024) {
        toast.error("Запись пустая, попробуйте ещё раз");
        return;
      }
      setBusy(true);
      try {
        const ext = rec.mimeType.includes("mp4") ? "mp4" : "webm";
        const fd = new FormData();
        fd.append("file", blob, `recording.${ext}`);
        // Эндпоинт распознавания пускает только сотрудников, поэтому токен
        // обязателен — как и в транспорте чата выше.
        const { data: session } = await supabase.auth.getSession();
        const token = session.session?.access_token;
        const res = await fetch("/api/transcribe", {
          method: "POST",
          body: fd,
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...activeStudioHeaders(),
          },
        });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { text?: string };
        const text = (data.text ?? "").trim();
        if (text) onTranscribed(text);
        else toast.error("Не удалось распознать речь");
      } catch (err) {
        toast.error(`Ошибка распознавания: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    };
    recorderRef.current = rec;
    streamRef.current = stream;
    rec.start();
    setRecording(true);
  };

  const stop = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    setRecording(false);
  };

  return (
    <Button
      type="button"
      variant={recording ? "destructive" : "outline"}
      size="icon"
      disabled={disabled || busy}
      onClick={recording ? stop : start}
      title={recording ? "Закончить запись" : "Голосовой ввод"}
      aria-label={recording ? "Закончить запись" : "Голосовой ввод"}
    >
      {busy ? <Loader2 className="animate-spin" /> : recording ? <Square /> : <Mic />}
    </Button>
  );
}

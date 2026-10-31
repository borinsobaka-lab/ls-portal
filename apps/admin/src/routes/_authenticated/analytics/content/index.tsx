import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { ExternalLink, Loader2, Send, Settings, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { useConfirm } from "@/components/confirm-dialog";
import { AnalyticsContentPageSkeleton } from "@/components/page-skeletons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { mskToday } from "@/lib/analytics/core";
import {
  CONTENT_BUCKET,
  CONTENT_KEY,
  contentCommunitiesQuery,
  contentPostsQuery,
  contentRpc,
  type ContentPost,
} from "@/lib/analytics/content/data";
import { publishContentNow } from "@/lib/analytics/content.functions";
import {
  CONTENT_BRANDS,
  CONTENT_STATUS,
  contentImagesProblem,
  contentLocalTime,
  contentZoneLabel,
} from "@/lib/analytics/content/rules";
import { AN_TITLES } from "@/lib/analytics/labels";

export const Route = createFileRoute("/_authenticated/analytics/content/")({
  head: () => ({ meta: [{ title: "Контент-план — Аналитика — Lady Stretch" }] }),
  pendingComponent: AnalyticsContentPageSkeleton,
  component: AnalyticsContentPage,
});

const TEXT = {
  lead: "Сервер проверяет очередь каждую минуту и публикует пост в локальное время каждой группы. В карточке видны результат и ссылка на пост VK.",
  links:
    "Используйте {ссылка_на_пробное} или {ссылка_на_расписание}, чтобы получить нужную ссылку в каждой группе.",
  images: "До 10 JPG, PNG, WEBP или GIF. Общий размер — до 24 МБ.",
};

const INSERTS: [string, string][] = [
  ["Ссылка на пробное", "{ссылка_на_пробное}"],
  ["Ссылка на расписание", "{ссылка_на_расписание}"],
  ["✨", "✨"],
  ["💜", "💜"],
  ["👇", "👇"],
];

const tone = (status: string) =>
  status === "published" ? "positive" : status === "error" ? "negative" : "neutral";

/**
 * «Контент» → «Контент-план» — их /admin/content: новый пост (направление,
 * текст с персональными ссылками, дата и время в городе группы, картинки,
 * группы) и лента постов с итогом публикации в каждой группе.
 */
function AnalyticsContentPage() {
  const posts = useQuery(contentPostsQuery);
  const communities = useQuery(contentCommunitiesQuery);
  return (
    <AdminShell title={AN_TITLES.content}>
      <div className="max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <InfoNote className="flex-1">{TEXT.lead}</InfoNote>
          <Button asChild variant="outline" size="sm">
            <Link to="/analytics/content/communities">
              <Settings />
              Настроить группы
            </Link>
          </Button>
        </div>
        {communities.data && (
          <NewPost communities={communities.data.communities.filter((c) => c.is_active)} />
        )}
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">Лента постов</h2>
            <span className="text-xs text-muted-foreground">Новые сверху</span>
          </div>
          {posts.error ? (
            <InfoNote variant="warning">{(posts.error as Error).message}</InfoNote>
          ) : !posts.data ? null : posts.data.posts.length ? (
            posts.data.posts.map((p) => <PostCard key={p.id} post={p} urls={posts.data.urls} />)
          ) : (
            <InfoNote variant="empty">В контент-плане ещё нет постов.</InfoNote>
          )}
        </section>
      </div>
    </AdminShell>
  );
}

type Community = {
  id: number;
  brand: string;
  display_name: string;
  city: string;
  timezone: string;
};

function NewPost({ communities }: { communities: Community[] }) {
  const qc = useQueryClient();
  const [brand, setBrand] = useState<string>(CONTENT_BRANDS[0]);
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(mskToday());
  const [time, setTime] = useState("10:00");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [targets, setTargets] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const visible = communities.filter((c) => c.brand === brand);

  const insert = (text: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + text + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = contentImagesProblem(files);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    const folder = crypto.randomUUID();
    const uploaded: { path: string; name: string }[] = [];
    try {
      for (const [i, f] of files.entries()) {
        const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
        const path = `${folder}/${i}${ext}`;
        const { error } = await supabase.storage
          .from(CONTENT_BUCKET)
          .upload(path, f, { contentType: f.type, upsert: false });
        if (error) throw new Error(`«${f.name}»: ${error.message}`);
        uploaded.push({ path, name: f.name });
      }
      await contentRpc("an_content_post_create", {
        p_brand: brand,
        p_title: title,
        p_body: body,
        p_publish_date: date,
        p_publish_time: time,
        p_targets: [...targets].filter((id) => visible.some((c) => c.id === id)),
        p_media: uploaded,
      });
      toast.success(
        "Пост добавлен в контент-план и будет опубликован в назначенное локальное время.",
      );
      setTitle("");
      setBody("");
      setFiles([]);
      setTargets(new Set());
      if (fileInput.current) fileInput.current.value = "";
      await qc.invalidateQueries({ queryKey: [...CONTENT_KEY] });
    } catch (err) {
      if (uploaded.length)
        await supabase.storage.from(CONTENT_BUCKET).remove(uploaded.map((u) => u.path));
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Новый пост</h2>
        <span className="text-xs text-muted-foreground">
          Emoji, несколько картинок и персональные ссылки.
        </span>
      </div>
      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Направление" required>
            <Select
              value={brand}
              onValueChange={(v) => {
                setBrand(v);
                // Их обновление списка: скрытые группы снимаются.
                setTargets(new Set());
              }}
            >
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
          <FormField label="Название для ленты" htmlFor="content-title">
            <Input
              id="content-title"
              value={title}
              placeholder="Например: Пост о пробном занятии"
              onChange={(e) => setTitle(e.target.value)}
            />
          </FormField>
          <FormField label="Дата публикации" required htmlFor="content-date">
            <Input
              id="content-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </FormField>
          <FormField label="Время в городе" required htmlFor="content-time">
            <Input
              id="content-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </FormField>
          <FormField
            label="Текст поста"
            required
            htmlFor="content-body"
            hint={TEXT.links}
            className="sm:col-span-2"
          >
            <Textarea
              id="content-body"
              ref={area}
              rows={8}
              value={body}
              placeholder="Добавьте текст, emoji и {ссылка_на_пробное}"
              onChange={(e) => setBody(e.target.value)}
            />
          </FormField>
          <div className="flex flex-wrap gap-1.5 sm:col-span-2">
            {INSERTS.map(([label, text]) => (
              <Button key={label} variant="outline" size="sm" onClick={() => insert(text)}>
                {label}
              </Button>
            ))}
          </div>
          <FormField
            label="Картинки"
            hint={TEXT.images}
            className="sm:col-span-2"
            htmlFor="content-images"
          >
            <Input
              id="content-images"
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={(e) => setFiles([...(e.target.files ?? [])])}
            />
          </FormField>
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Группы для публикации</h3>
          <p className="text-xs text-muted-foreground">
            Показываются только активные группы выбранного направления.
          </p>
          {visible.length ? (
            <div className="grid gap-1 sm:grid-cols-2">
              {visible.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 text-sm hover:bg-accent"
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={targets.has(c.id)}
                    onCheckedChange={(v) =>
                      setTargets((cur) => {
                        const next = new Set(cur);
                        if (v === true) next.add(c.id);
                        else next.delete(c.id);
                        return next;
                      })
                    }
                  />
                  <span>
                    <b className="font-medium">{c.display_name}</b>
                    <small className="block text-xs text-muted-foreground">
                      {c.brand} · {c.city} · {contentZoneLabel(c.timezone)}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Сначала добавьте активные группы в настройках.
            </p>
          )}
        </div>
        <Button type="submit" disabled={saving || !communities.length}>
          {saving && <Loader2 className="animate-spin" />}
          Добавить в контент-план
        </Button>
      </form>
    </section>
  );
}

function PostCard({ post, urls }: { post: ContentPost; urls: Map<string, string> }) {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState<number | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: [...CONTENT_KEY] });
  return (
    <article className="space-y-3 rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip tone={tone(post.publication_status)}>
              {CONTENT_STATUS[post.publication_status] ?? "Ожидает"}
            </StatusChip>
            <span className="text-xs text-muted-foreground">
              {post.brand} · {post.publish_date} · локально {post.publish_time}
            </span>
          </div>
          <b className="block">{post.title || "Без названия"}</b>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            if (
              !(await confirm({
                title: "Удалить этот пост из контент-плана?",
                description:
                  "Он больше не будет опубликован. Уже опубликованные записи в VK останутся.",
                confirmLabel: "Удалить",
              }))
            )
              return;
            try {
              const paths = await contentRpc<string[]>("an_content_post_delete", { p_id: post.id });
              if (paths?.length) await supabase.storage.from(CONTENT_BUCKET).remove(paths);
              toast.success(
                "Пост удалён из контент-плана. Записи, уже опубликованные в VK, не изменены.",
              );
              await refresh();
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
        >
          <Trash2 />
          Удалить
        </Button>
      </div>
      <p className="text-sm whitespace-pre-wrap">{post.body}</p>
      {post.media.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {post.media.map((m) =>
            urls.get(m.path) ? (
              <img
                key={m.id}
                src={urls.get(m.path)}
                alt={m.name}
                className="size-28 rounded-md object-cover"
              />
            ) : null,
          )}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Группы и время ({post.targets.length})
        </summary>
        <ul className="mt-2 space-y-2">
          {post.targets.map((t) => (
            <li key={t.community_id} className="flex flex-wrap items-center gap-2 text-sm">
              <b className="font-medium">{t.display_name}</b>
              <span className="text-muted-foreground">
                · {contentLocalTime(t.scheduled_at, t.timezone)} ({contentZoneLabel(t.timezone)})
              </span>
              <StatusChip tone={tone(t.publication_status)}>
                {CONTENT_STATUS[t.publication_status] ?? "Ожидает"}
              </StatusChip>
              {t.publication_status === "published" ? (
                <Button asChild variant="outline" size="sm">
                  <a href={t.vk_post_url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink />
                    Открыть пост VK
                  </a>
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy === t.community_id}
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: `Опубликовать этот пост в группе «${t.display_name}» сейчас?`,
                        confirmLabel: "Опубликовать",
                        destructive: false,
                      }))
                    )
                      return;
                    setBusy(t.community_id);
                    try {
                      const r = await publishContentNow({
                        data: { postId: post.id, communityId: t.community_id },
                      });
                      toast.success(r.message);
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setBusy(null);
                      await refresh();
                    }
                  }}
                >
                  {busy === t.community_id ? <Loader2 className="animate-spin" /> : <Send />}
                  Опубликовать сейчас
                </Button>
              )}
              {t.publication_status === "error" && t.error_text && (
                <small className="w-full text-xs text-destructive">{t.error_text}</small>
              )}
            </li>
          ))}
        </ul>
      </details>
      {confirmDialog}
    </article>
  );
}

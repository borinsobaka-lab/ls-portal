import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Plus, Save, X } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { fitImage, squareImage, uploadToStorage } from "@/lib/storage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { ImageUploadField, StorageImage } from "@/components/image-upload-field";
import { AppAboutFormSkeleton, AppAboutPageSkeleton } from "@/components/page-skeletons";
import { useStudios } from "@/hooks/use-studios";
import { STUDIO_FORMAT_APP_URL } from "@/lib/studio-formats";

export const Route = createFileRoute("/_authenticated/app-about")({
  head: () => ({ meta: [{ title: "О нас — Base40 Admin" }] }),
  pendingComponent: AppAboutPageSkeleton,
  component: AppAboutPage,
});

const TIPS = {
  cover: "Первый экран раздела: поверх фото — логотип, под ним заголовок и вводный текст.",
  gallery: "Галерея листается пальцем. Порядок — как здесь, стрелками можно переставить.",
  community: "Широкий кадр из жизни студий под цифрами: общая тренировка или интерьер.",
  counts:
    "Крупные цифры в блоке «Больше, чем тренировки», в приложении — с плюсом: «3 500+» (число специалистов — точное, без плюса). Только реальные числа; пустое поле — показатель не показывается.",
  instagram:
    "Последние фото из Instagram, вручную. В приложении — сетка 3×2, фото обрезаются до квадрата. Нажатие открывает пост по ссылке или, без ссылки, профиль.",
};

/** Сколько фото в галерее студии и в сетке Instagram. */
const GALLERY_MAX = 5;
const INSTAGRAM_SLOTS = 6;

/** Цифры сообщества: колонка, подпись в форме, как читается в приложении. */
const COUNTS = [
  {
    key: "visitors_count",
    label: "Девушек посетили студии",
    example: "3 500+ девушек уже посетили наши тренировки",
  },
  {
    key: "group_trainings_count",
    label: "Проведено групповых тренировок",
    example: "10 000+ групповых тренировок проведено",
  },
  { key: "visits_count", label: "Посещений", example: "45 000+ посещений тренировок" },
  {
    key: "specialists_count",
    label: "Специалистов в команде",
    example: "18 специалистов работают над тем, чтобы делать жизнь наших клиенток лучше",
  },
] as const;
type CountKey = (typeof COUNTS)[number]["key"];

/** Папка в бакете studio-photos. */
const FOLDER = "about";

type InstagramPost = { path: string; url: string | null };

type Settings = {
  format: "packages";
  cover_photo_path: string | null;
  first_studio_photos: string[];
  second_studio_photos: string[];
  massage_photos: string[];
  community_photo_path: string | null;
  visitors_count: number | null;
  group_trainings_count: number | null;
  visits_count: number | null;
  specialists_count: number | null;
  instagram_followers: number | null;
  instagram_posts: InstagramPost[];
};

type FormValues = {
  cover: string | null;
  first: string[];
  second: string[];
  massage: string[];
  community: string | null;
  counts: Record<CountKey, string>;
  followers: string;
  /** Ровно INSTAGRAM_SLOTS ячеек; пустая — path null. */
  instagram: { path: string | null; url: string }[];
};

function toFormValues(s: Settings | null | undefined): FormValues {
  const posts = s?.instagram_posts ?? [];
  return {
    cover: s?.cover_photo_path ?? null,
    first: s?.first_studio_photos ?? [],
    second: s?.second_studio_photos ?? [],
    massage: s?.massage_photos ?? [],
    community: s?.community_photo_path ?? null,
    counts: Object.fromEntries(
      COUNTS.map((c) => [c.key, s?.[c.key] ? String(s[c.key]) : ""]),
    ) as Record<CountKey, string>,
    followers: s?.instagram_followers ? String(s.instagram_followers) : "",
    instagram: Array.from({ length: INSTAGRAM_SLOTS }, (_, i) => ({
      path: posts[i]?.path ?? null,
      url: posts[i]?.url ?? "",
    })),
  };
}

// «О нас» — история бренда в приложении пакетных клубов (Lady Stretch).
// Тексты и даты — в коде приложения (apps/client/src/formats/packages/
// about-config.ts), здесь — фото, цифры сообщества и Instagram:
// app_about_settings, строка на формат
// (db/migrations/2026-10-12_zzzzzz_app_about_page.sql; галерея массажного
// кабинета — 2026-10-12_zzzzzzz_app_about_massage.sql). Пока в приложении
// одна такая история — у пакетного; правит раздел «Мобильное приложение» и
// сотрудник пакетного клуба (так же пускает RLS).
const TABLE = "app_about_settings";
const FORMAT = "packages";
const QUERY_KEY = [TABLE, FORMAT];

const FORM_ID = "app-about-form";

function AppAboutPage() {
  const { data: studios = [], isPending: studiosLoading } = useStudios();
  const hasPackages = studios.some((s) => s.format === FORMAT);
  const [saving, setSaving] = useState(false);

  return (
    <AdminShell
      title="О нас"
      actions={
        <Button type="submit" form={FORM_ID} disabled={saving || studiosLoading || !hasPackages}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Сохранить
        </Button>
      }
    >
      {studiosLoading ? (
        <AppAboutFormSkeleton />
      ) : !hasPackages ? (
        <InfoNote variant="empty" className="max-w-2xl">
          Раздел «О нас» есть только в приложении клубов с пакетами тренировок, а у вас таких клубов
          нет.
        </InfoNote>
      ) : (
        <AppAboutForm onSavingChange={setSaving} />
      )}
    </AdminShell>
  );
}

function AppAboutForm({ onSavingChange }: { onSavingChange: (saving: boolean) => void }) {
  const queryClient = useQueryClient();
  const { data: settings, isPending: loading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () =>
      unwrap<Settings | null>(supabase.from(TABLE).select("*").eq("format", FORMAT).maybeSingle()),
    meta: { errorMessage: "Не удалось загрузить раздел «О нас»" },
  });

  // Как в «Контактах и правилах»: правки отдельно от загруженного, пока
  // ничего не трогали — форма показывает данные с сервера.
  const [draft, setDraft] = useState<FormValues | null>(null);
  const form = draft ?? toFormValues(settings);
  const setField = <K extends keyof FormValues>(field: K, value: FormValues[K]) =>
    setDraft((prev) => ({ ...(prev ?? form), [field]: value }));

  const handleSave = async () => {
    const counts = {} as Record<CountKey, number | null>;
    for (const c of COUNTS) {
      const text = form.counts[c.key].replace(/\s/g, "");
      const n = /^\d+$/.test(text) ? Number(text) : null;
      if (text && (n === null || n <= 0)) {
        toast.error(`«${c.label}» — целое число больше нуля или пусто`);
        return;
      }
      counts[c.key] = n;
    }
    const followersText = form.followers.replace(/\s/g, "");
    const followers = /^\d+$/.test(followersText) ? Number(followersText) : null;
    if (followersText && (followers === null || followers <= 0)) {
      toast.error("«Подписчиков в Instagram» — целое число больше нуля или пусто");
      return;
    }
    const badLink = form.instagram.find((p) => p.url.trim() && !/^https?:\/\//i.test(p.url.trim()));
    if (badLink) {
      toast.error("Ссылка на пост Instagram должна начинаться с https://");
      return;
    }
    onSavingChange(true);
    try {
      const saved: Settings = {
        format: FORMAT,
        cover_photo_path: form.cover,
        first_studio_photos: form.first,
        second_studio_photos: form.second,
        massage_photos: form.massage,
        community_photo_path: form.community,
        ...counts,
        instagram_followers: followers,
        instagram_posts: form.instagram
          .filter((p): p is { path: string; url: string } => !!p.path)
          .map((p) => ({ path: p.path, url: p.url.trim() || null })),
      };
      const { error } = await supabase
        .from(TABLE)
        .upsert({ ...saved, updated_at: new Date().toISOString() }, { onConflict: "format" });
      if (error) {
        toast.error("Не удалось сохранить", { description: error.message });
        return;
      }
      queryClient.setQueryData<Settings | null>(QUERY_KEY, saved);
      setDraft(null);
      toast.success("Раздел «О нас» сохранён");
    } finally {
      onSavingChange(false);
    }
  };

  if (loading) return <AppAboutFormSkeleton />;

  const host = STUDIO_FORMAT_APP_URL[FORMAT].replace(/^https?:\/\//, "");

  return (
    <form
      id={FORM_ID}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
      className="max-w-2xl space-y-8"
    >
      <InfoNote>
        Раздел «Студия» → «О нас» в приложении {host}: история Lady Stretch от первой студии до
        сообщества. Тексты и даты заданы в приложении, здесь — фото, цифры и Instagram. Пока фото не
        загружено, приложение показывает временное.
      </InfoNote>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <SectionTitle title="Обложка" text="Атмосферный интерьер одной из студий." />
        <FormField label="Фото обложки" tip={TIPS.cover} htmlFor={null} optional>
          <ImageUploadField
            bucket="studioPhotos"
            folder={`${FOLDER}/cover`}
            value={form.cover}
            onChange={(v) => setField("cover", v)}
            prepare={(f) => fitImage(f)}
          />
        </FormField>
        <p className="text-xs text-muted-foreground">
          Горизонтальное 16:9, от 1600 px по ширине: в приложении обрезается до 16:9, поверх слева
          вверху — логотип.
        </p>
      </section>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <SectionTitle title="Наша первая студия" text="Ваке, сентябрь 2023." />
        <FormField label="Фото студии" tip={TIPS.gallery} htmlFor={null} optional>
          <GalleryField
            folder={`${FOLDER}/first-studio`}
            value={form.first}
            onChange={(v) => setField("first", v)}
          />
        </FormField>
      </section>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <SectionTitle title="Наша вторая студия" text="Сабуртало, август 2024." />
        <FormField label="Фото студии" tip={TIPS.gallery} htmlFor={null} optional>
          <GalleryField
            folder={`${FOLDER}/second-studio`}
            value={form.second}
            onChange={(v) => setField("second", v)}
          />
        </FormField>
      </section>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <SectionTitle title="Массажный кабинет" text="Для клиенток студий, июнь 2026." />
        <FormField label="Фото кабинета" tip={TIPS.gallery} htmlFor={null} optional>
          <GalleryField
            folder={`${FOLDER}/massage`}
            value={form.massage}
            onChange={(v) => setField("massage", v)}
          />
        </FormField>
      </section>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <SectionTitle title="Сообщество" text="Блок «Больше, чем тренировки»: цифры и фото." />
        {COUNTS.map((c) => (
          <FormField
            key={c.key}
            label={c.label}
            tip={TIPS.counts}
            hint={`В приложении: «${c.example}».`}
            optional
          >
            <Input
              inputMode="numeric"
              placeholder="Не показывать"
              value={form.counts[c.key]}
              onChange={(e) => setField("counts", { ...form.counts, [c.key]: e.target.value })}
              className="max-w-48"
            />
          </FormField>
        ))}
        <FormField label="Широкое фото" tip={TIPS.community} htmlFor={null} optional>
          <ImageUploadField
            bucket="studioPhotos"
            folder={`${FOLDER}/community`}
            value={form.community}
            onChange={(v) => setField("community", v)}
            prepare={(f) => fitImage(f)}
          />
        </FormField>
      </section>

      <section className="space-y-4 rounded-lg border bg-background p-6">
        <SectionTitle
          title="Instagram"
          text="Шесть последних фото профиля @ladystretch_tbilisi. Без фото в приложении — плашка со ссылкой на профиль, без сетки."
        />
        <FormField
          label="Подписчиков в Instagram"
          hint="В плашке под названием профиля: «7 200+ подписчиков». Пусто — без строки."
          optional
        >
          <Input
            inputMode="numeric"
            placeholder="Не показывать"
            value={form.followers}
            onChange={(e) => setField("followers", e.target.value)}
            className="max-w-48"
          />
        </FormField>
        <FormField
          label="Фото и ссылки на посты"
          tip={TIPS.instagram}
          hint="Ссылка необязательна: фото без ссылки ведёт в профиль. В приложении — все загруженные фото по порядку ячеек, лучше 3 или 6 (полные ряды)."
          htmlFor={null}
          optional
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {form.instagram.map((post, i) => (
              <InstagramSlot
                key={i}
                index={i}
                post={post}
                onChange={(next) =>
                  setField(
                    "instagram",
                    form.instagram.map((p, j) => (j === i ? next : p)),
                  )
                }
              />
            ))}
          </div>
        </FormField>
      </section>
    </form>
  );
}

function SectionTitle({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

/** Галерея студии: до GALLERY_MAX фото, порядок стрелками. */
function GalleryField({
  folder,
  value,
  onChange,
}: {
  folder: string;
  value: string[];
  onChange: (paths: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const free = GALLERY_MAX - value.length;

  const upload = async (files: File[]) => {
    setUploading(true);
    try {
      const paths: string[] = [];
      for (const file of files.slice(0, free)) {
        paths.push(await uploadToStorage("studioPhotos", folder, await fitImage(file)));
      }
      onChange([...value, ...paths]);
      if (files.length > free) toast.info(`В галерее — не больше ${GALLERY_MAX} фото`);
    } catch (err) {
      toast.error("Ошибка загрузки: " + (err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const move = (from: number, to: number) => {
    const next = [...value];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {value.map((path, i) => (
            <div key={path} className="space-y-1">
              <div className="relative">
                <StorageImage
                  bucket="studioPhotos"
                  value={path}
                  alt={`Фото ${i + 1}`}
                  className="h-28 w-[90px]"
                />
                <Button
                  variant="secondary"
                  size="icon-sm"
                  className="absolute -right-2 -top-2 border"
                  aria-label="Убрать фото"
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              </div>
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Левее"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  <ChevronLeft />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Правее"
                  disabled={i === value.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  <ChevronRight />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) upload(files);
        }}
      />
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={uploading || free <= 0}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? <Loader2 className="animate-spin" /> : <Plus />}
          {uploading ? "Загрузка…" : "Добавить фото"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {value.length} из {GALLERY_MAX}. Лучше 3–5 вертикальных (около 4:5), от 1200 px.
        </span>
      </div>
    </div>
  );
}

/** Ячейка сетки Instagram: квадратное фото и ссылка на пост. */
function InstagramSlot({
  index,
  post,
  onChange,
}: {
  index: number;
  post: { path: string | null; url: string };
  onChange: (next: { path: string | null; url: string }) => void;
}) {
  return (
    <div className="space-y-2">
      <ImageUploadField
        bucket="studioPhotos"
        folder={`${FOLDER}/instagram`}
        value={post.path}
        onChange={(path) => onChange({ path, url: path ? post.url : "" })}
        prepare={(f) => squareImage(f, 720)}
        preview={
          <StorageImage
            bucket="studioPhotos"
            value={post.path}
            alt={`Instagram ${index + 1}`}
            className="h-16 w-16 shrink-0"
          />
        }
      />
      <FormField label="Ссылка на пост" optional>
        <Input
          aria-label={`Ссылка на пост ${index + 1}`}
          value={post.url}
          disabled={!post.path}
          onChange={(e) => onChange({ ...post, url: e.target.value })}
        />
      </FormField>
    </div>
  );
}

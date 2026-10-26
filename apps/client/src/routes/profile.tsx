import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  SquircleAvatar,
  SquircleAvatarFallback,
  SquircleAvatarImage,
  squircleClipPath,
} from "@/components/ui/squircle-avatar";
import { SelectItem } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet";
import {
  Refresh,
  Pen,
  Logout,
  Camera,
  DocumentText,
  Card2,
  ChatRound,
  AltArrowRight,
  Global,
} from "@solar-icons/react";
import { FloatingLabelInput, FloatingLabelSelect } from "@/components/ui/floating-input";
import { toast } from "sonner";
import { z } from "zod";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { clientCardQuery, type ClientCard } from "@/lib/client-card";
import { PageShell } from "@/components/page-shell";
import { APP_BRAND, IS_PACKAGES } from "@/lib/terms";
import { STUDIO_WHATSAPP_URL } from "@/formats/packages/studio-contacts";
import { PRIVACY_POLICY_INFO } from "@/lib/legal";
import { isValidPhone } from "@/lib/phone";
import { PhoneInput } from "@/components/ui/phone-input";
import { LanguageSheet } from "@/components/language-switcher";
import { PushSettingsRow } from "@/components/push-prompt";
import { AboutAppRow } from "@/components/about-app";
import { PrivacyPolicyDrawer } from "@/components/privacy-policy-drawer";
import { LOCALES, currentT, getTranslator, msg, useI18n, useT, type Translator } from "@/i18n";

export const Route = createFileRoute("/profile")({
  head: ({ match }) => {
    const t = getTranslator(match.context.locale);
    return {
      meta: [
        { title: t("Профиль — {brand}", { brand: APP_BRAND }) },
        { name: "description", content: t("Профиль участника {brand}.", { brand: APP_BRAND }) },
      ],
    };
  },
  component: ProfilePage,
});

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

type ClientRow = ClientCard;

type ClientUpdate = {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  phone?: string | null;
  email?: string | null;
  birthday?: string | null;
  gender?: string | null;
};

// Сообщения — ключи словаря (msg), переводятся при показе.
const profileSchema = z.object({
  first_name: z.string().trim().min(1, msg("Укажите имя")).max(60, msg("Слишком длинное имя")),
  last_name: z
    .string()
    .trim()
    .min(1, msg("Укажите фамилию"))
    .max(60, msg("Слишком длинная фамилия")),
  phone: z
    .string()
    .trim()
    .max(32, msg("Слишком длинный номер"))
    .refine((v) => !v || isValidPhone(v), msg("Проверьте номер телефона"))
    .optional()
    .or(z.literal("")),
  email: z.string().trim().email(msg("Некорректный email")).max(255).optional().or(z.literal("")),
  birthday: z.string().optional().or(z.literal("")),
  gender: z.string().optional().or(z.literal("")),
});

function composeFullName(
  c: Pick<ClientRow, "full_name" | "first_name" | "last_name"> | null | undefined,
) {
  if (!c) return "";
  const composed = [c.last_name, c.first_name].filter(Boolean).join(" ").trim();
  return composed || (c.full_name ?? "");
}

function splitFullName(full: string | null | undefined): { first: string; last: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { last: parts[0], first: parts.slice(1).join(" ") };
}

function formFromClient(client: ClientRow) {
  const split = splitFullName(client.full_name);
  return {
    first_name: client.first_name ?? split.first,
    last_name: client.last_name ?? split.last,
    phone: client.phone ?? "",
    email: client.email ?? "",
    birthday: client.birthday ?? "",
    gender: client.gender ?? "",
  };
}

/**
 * Дата рождения (date, "YYYY-MM-DD") для показа. Не через new Date(): строка
 * без времени разбирается как полночь UTC, и западнее Гринвича выходил
 * предыдущий день.
 */
function formatBirthday(value: string, t: Translator) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  // Полночь UTC и показ в UTC — тот же день в любом часовом поясе.
  return t.date(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])), {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/**
 * Сторона квадратной аватарки после сжатия, px, и качество WebP/JPEG
 * (решение владельца 2026-10-14: аватарок будет много — геймификация, —
 * грузиться должны быстро). Самая крупная аватарка на экране — 120px в
 * профиле: 320px хватает и на экранах 2–3x, файл — порядка 15–25 КБ
 * (512px и 0.86 давали в 3–4 раза больше).
 */
const AVATAR_SIZE = 320;
const AVATAR_QUALITY = 0.8;

// Выбор файла аватарки. Константой, а не литералом в JSX: проверка словарей
// (scripts/i18n-check.ts) принимала слэш со звёздочкой в этой строке за начало
// комментария и не видела t() до конца следующего комментария.
const AVATAR_ACCEPT = "image/*";

/**
 * Фото с телефона — в квадрат AVATAR_SIZE WebP (JPEG, если браузер не умеет WebP):
 * снимок камеры весит 3–10 МБ (раньше такие отклонялись «Файл больше 5 МБ»),
 * HEIC с iPhone браузер сам декодирует. Ориентацию EXIF браузер учитывает при
 * отрисовке. Не удалось открыть картинку — null.
 */
async function squareAvatar(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode"));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) return null;
    const size = Math.min(AVATAR_SIZE, side);
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // Сильное уменьшение (снимок 4000px → 320px) без сглаживания даёт «лесенку».
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      img,
      (img.naturalWidth - side) / 2,
      (img.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    );
    const encode = (type: string) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, AVATAR_QUALITY));
    const webp = await encode("image/webp");
    // Старый Safari вместо WebP молча отдаёт PNG — тогда JPEG (легче).
    return webp?.type === "image/webp" ? webp : await encode("image/jpeg");
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Загружает аватар в storage (папка {uid}/ бакета avatars — политики
 * db/migrations/2026-10-12_zz_packages_app_fixes.sql) и пишет ссылку в
 * карточку клиента. Общая для страницы профиля и шторки редактирования.
 * Возвращает обновлённую строку clients или undefined, если загрузка не
 * удалась (ошибку уже показали тостом).
 */
async function uploadAvatar(userId: string, file: File): Promise<ClientRow | undefined> {
  const t = currentT();
  if (!file.type.startsWith("image/") && !/\.(heic|heif)$/i.test(file.name)) {
    toast.error(t("Выберите изображение"));
    return undefined;
  }
  const blob = await squareAvatar(file);
  if (!blob) {
    toast.error(t("Не удалось открыть фото. Выберите снимок в формате JPG или PNG."));
    return undefined;
  }
  const ext = blob.type === "image/webp" ? "webp" : "jpg";
  // Новое имя на каждую загрузку: без перезаписи (upsert требовал прав на
  // чтение и правку старого файла) и без старой картинки из кэша браузера.
  const path = `${userId}/avatar-${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from("avatars")
    .upload(path, blob, { contentType: blob.type, cacheControl: "31536000" });
  if (upErr) {
    toast.error(t("Не удалось загрузить фото: {error}", { error: upErr.message }));
    return undefined;
  }
  const publicUrl = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
  const { data: updated, error: dbErr } = await supabase
    .from("clients")
    .update({ photo_url: publicUrl } as never)
    .eq("user_id", userId)
    .select()
    .maybeSingle();
  if (dbErr) {
    toast.error(t("Не удалось сохранить фото: {error}", { error: dbErr.message }));
    return undefined;
  }
  // Ни одной строки: карточки нет или правка своей карточки закрыта — без
  // этого показывали «Аватар обновлён», а фото пропадало после обновления.
  if (!updated) {
    toast.error(t("Не удалось сохранить фото в профиль. Обратитесь к администратору студии."));
    return undefined;
  }
  toast.success(t("Фото обновлено"));
  return updated as ClientRow;
}

/**
 * Сохраняет поля карточки клиента. Если update не нашёл строку (карточки нет),
 * заводит её через ensure_client_profile, как везде в приложении, и повторяет
 * update. Прямой insert создавал карточку без studio_id и мог продублировать
 * существующую.
 */
async function saveClient(
  userId: string,
  payload: ClientUpdate,
): Promise<{ row: ClientRow } | { error: string }> {
  const update = () => supabase.from("clients").update(payload).eq("user_id", userId).select();
  let { data, error } = await update();
  if (!error && !data?.length) {
    // ensure_client_profile нет в сгенерированных types.ts.
    const { error: ensureError } = await (
      supabase as unknown as {
        rpc: (fn: "ensure_client_profile") => PromiseLike<{ error: { message: string } | null }>;
      }
    ).rpc("ensure_client_profile");
    if (ensureError) return { error: ensureError.message };
    ({ data, error } = await update());
  }
  if (error) return { error: error.message };
  const row = data?.[0];
  if (row) return { row: row as ClientRow };
  const t = currentT();
  return { error: t("карточка клиента не найдена") };
}

function ProfilePage() {
  const { user, signOut } = useAuth();
  const t = useT();
  const { locale } = useI18n();
  const currentLanguage = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
  const [languageOpen, setLanguageOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const queryClient = useQueryClient();
  // Карточка — из общего с главной кэша (src/lib/client-card.ts): профиль
  // открывается сразу, свежие данные подтягиваются фоном.
  const cardQuery = clientCardQuery(user?.id ?? null);
  const { data: cardData, isPending } = useQuery(cardQuery);
  const client = cardData ?? null;
  const loading = !!user && isPending;
  const setClient = (fn: (prev: ClientRow | null) => ClientRow) =>
    queryClient.setQueryData(cardQuery.queryKey, (prev) => fn(prev ?? null));
  const [editOpen, setEditOpen] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // Подписка Realtime на свою карточку убрана (2026-10-16, запуск): лишнее
  // постоянное соединение с каждого телефона; правки администратора
  // приходят при следующем открытии профиля.

  const fullName =
    composeFullName(client) || (user?.user_metadata?.full_name as string) || t("Участник");
  const email = client?.email || user?.email || "";
  const phone = client?.phone || "";
  const birthday = client?.birthday || "";
  const gender = client?.gender || "";

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;
    setUploadingAvatar(true);
    const updated = await uploadAvatar(user.id, file);
    setUploadingAvatar(false);
    if (updated) setClient((prev) => ({ ...prev, ...updated }));
  };

  return (
    <PageShell
      header={
        <div className="pt-4 pb-8 px-4">
          <h1 className="text-3xl font-semibold">{t("Профиль")}</h1>
          <p className="text-sm text-white/70">{t("Ваши данные и настройки")}</p>
        </div>
      }
    >
      <div className="pt-6 pb-8">
        <div className="bg-muted">
          {/* Блок: данные пользователя */}
          <section className="relative bg-background rounded-b-[14px] px-4 pt-3 pb-5">
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              disabled={loading || !client}
              className="absolute top-3 right-3 h-9 w-9 rounded-full bg-muted text-muted-foreground flex items-center justify-center disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label={t("Редактировать профиль")}
            >
              <Pen className="h-4 w-4" weight="BoldDuotone" />
            </button>
            <div className="flex flex-col items-center gap-3">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadingAvatar || loading}
                className="relative shrink-0 focus:outline-none disabled:opacity-70"
                style={{ width: 120, height: 120 }}
                aria-label={t("Заменить аватар")}
              >
                <SquircleAvatar size={120}>
                  {client?.photo_url && (
                    <SquircleAvatarImage src={client.photo_url} alt={fullName} />
                  )}
                  <SquircleAvatarFallback className="bg-muted text-foreground text-3xl font-semibold">
                    {loading ? (
                      <Refresh className="h-6 w-6 animate-spin" weight="BoldDuotone" />
                    ) : (
                      initials(fullName)
                    )}
                  </SquircleAvatarFallback>
                </SquircleAvatar>
                {uploadingAvatar && (
                  <div
                    className="absolute inset-0 bg-black/40 flex items-center justify-center"
                    style={{
                      clipPath: squircleClipPath(120),
                      WebkitClipPath: squircleClipPath(120),
                    }}
                  >
                    <Refresh className="h-6 w-6 text-white animate-spin" weight="BoldDuotone" />
                  </div>
                )}
                <span className="absolute -bottom-1 -right-1 h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center border-2 border-background">
                  <Camera className="h-4 w-4" />
                </span>
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept={AVATAR_ACCEPT}
                className="hidden"
                onChange={handleAvatarUpload}
              />
              <div className="text-center">
                <div className="font-semibold text-lg">{fullName}</div>
              </div>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
              <ProfileField label={t("Телефон")} value={phone} />
              <ProfileField label={t("Email")} value={email} />
              <ProfileField
                label={t("Дата рождения")}
                value={birthday ? formatBirthday(birthday, t) : ""}
              />
              <ProfileField
                label={t("Пол")}
                value={gender === "male" ? t("Мужской") : gender === "female" ? t("Женский") : ""}
              />
            </dl>
          </section>

          <div className="h-3 bg-muted" />

          {/* Блок: ссылки */}
          <section className="bg-background rounded-t-[14px] rounded-b-[14px] py-1">
            <ul className="divide-y divide-border">
              {/* Пуши: «Включены» или красным «Выключены» с «Включить»
                  (решение владельца 2026-10-15). */}
              <PushSettingsRow />
              {/* Оплаты в приложении пакетных студий пока нет (решение владельца
                  2026-10-12) — блок способов оплаты не показываем. */}
              {!IS_PACKAGES && (
                <ProfileLink
                  icon={<Card2 className="h-5 w-5" weight="BoldDuotone" />}
                  label={t("Способы оплаты")}
                  sublabel="Mastercard •••• 4242"
                  right={<MastercardBadge />}
                />
              )}
              <ProfileLink
                icon={<ChatRound className="h-5 w-5" weight="BoldDuotone" />}
                label={t("Поддержка")}
                // Пакетное приложение — чат WhatsApp студии (тот же номер, что
                // на экране входа); у подписочного своего номера пока нет.
                onClick={
                  IS_PACKAGES
                    ? () => window.open(STUDIO_WHATSAPP_URL, "_blank", "noopener,noreferrer")
                    : undefined
                }
              />
              {/* Язык — как остальные строки; по нажатию — шторка со списком языков. */}
              <ProfileLink
                icon={<Global className="h-5 w-5" weight="BoldDuotone" />}
                label={t("Язык")}
                right={
                  <span className="text-sm text-muted-foreground">{currentLanguage.name}</span>
                }
                onClick={() => setLanguageOpen(true)}
              />
              {/* По нажатию — шторка снизу: о приложении, версия и
                  техническая информация для администратора (2026-10-15). */}
              <AboutAppRow />
              {/* Lady Stretch: единственный юридический документ приложения —
                  политика конфиденциальности (решение владельца 2026-10-13); последней
                  строкой, после «О приложении» (2026-10-14); открывается шторкой
                  снизу (2026-10-15). */}
              {PRIVACY_POLICY_INFO ? (
                <ProfileLink
                  icon={<DocumentText className="h-5 w-5" weight="BoldDuotone" />}
                  label={t("Политика конфиденциальности")}
                  onClick={() => setPrivacyOpen(true)}
                />
              ) : (
                <ProfileLink
                  icon={<DocumentText className="h-5 w-5" weight="BoldDuotone" />}
                  label={t("Правовые документы")}
                />
              )}
            </ul>
          </section>

          <div className="h-3 bg-muted" />

          {/* Блок: выход */}
          <section className="bg-background rounded-t-[14px] px-4 py-5">
            <Button variant="outline" className="w-full shadow-none" onClick={() => signOut()}>
              {t("Выйти")}
            </Button>
          </section>
        </div>

        {client && (
          <EditProfileSheet
            open={editOpen}
            onOpenChange={setEditOpen}
            client={client}
            onSaved={(updated) => setClient((prev) => ({ ...prev, ...updated }))}
          />
        )}
      </div>
      <LanguageSheet open={languageOpen} onOpenChange={setLanguageOpen} />
      <PrivacyPolicyDrawer open={privacyOpen} onOpenChange={setPrivacyOpen} />
    </PageShell>
  );
}

function ProfileField({ label, value }: { label: string; value?: string | null }) {
  const t = useT();
  const isEmpty = !value || value.length === 0;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 text-sm font-medium break-words ${isEmpty ? "text-muted-foreground/60 italic" : ""}`}
      >
        {isEmpty ? t("не указано") : value}
      </dd>
    </div>
  );
}

function ProfileLink({
  icon,
  label,
  sublabel,
  right,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  right?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center gap-3 px-4 py-4 text-left"
      >
        <span className="text-muted-foreground">{icon}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium">{label}</span>
          {sublabel && (
            <span className="block text-xs text-muted-foreground mt-0.5">{sublabel}</span>
          )}
        </span>
        {right}
        <AltArrowRight className="h-4 w-4 text-muted-foreground" weight="BoldDuotone" />
      </button>
    </li>
  );
}

function MastercardBadge() {
  return (
    <span
      aria-label="Mastercard"
      className="inline-flex items-center justify-center h-6 w-9 rounded-[4px] bg-[#1a1a1a]"
    >
      <svg viewBox="0 0 24 16" className="h-3.5 w-auto" aria-hidden="true">
        <circle cx="9" cy="8" r="6" fill="#EB001B" />
        <circle cx="15" cy="8" r="6" fill="#F79E1B" />
        <path d="M12 3.6a6 6 0 0 1 0 8.8 6 6 0 0 1 0-8.8z" fill="#FF5F00" />
      </svg>
    </span>
  );
}

function EditProfileSheet({
  open,
  onOpenChange,
  client,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: ClientRow;
  onSaved: (updated: ClientRow) => void;
}) {
  const { user } = useAuth();
  const t = useT();
  const [form, setForm] = useState(() => formFromClient(client));
  const [saving, setSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(client.photo_url ?? null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;
    setUploadingAvatar(true);
    const updated = await uploadAvatar(user.id, file);
    setUploadingAvatar(false);
    if (!updated) return;
    setAvatarUrl(updated.photo_url ?? null);
    onSaved(updated);
  };

  // Заполняем форму из карточки только в момент открытия. Раньше эффект
  // срабатывал на каждое изменение `client` — загрузка аватара в этой же
  // шторке или realtime-обновление карточки затирали несохранённые правки.
  // Аватар тоже берём свежий: шторка смонтирована постоянно, и фото,
  // сменённое на странице профиля, здесь оставалось старым.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setForm(formFromClient(client));
      setAvatarUrl(client.photo_url ?? null);
    }
    wasOpenRef.current = open;
  }, [open, client]);

  const handleSave = async () => {
    if (!user) return;
    const parsed = profileSchema.safeParse(form);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message;
      toast.error(issue ? t(issue) : t("Проверьте поля"));
      return;
    }
    const v = parsed.data;
    const fullName = [v.last_name, v.first_name].filter(Boolean).join(" ").trim();
    const payload: ClientUpdate = {
      first_name: v.first_name,
      last_name: v.last_name,
      full_name: fullName,
      phone: v.phone ? v.phone : null,
      email: v.email ? v.email : null,
      birthday: v.birthday ? v.birthday : null,
      gender: v.gender ? v.gender : null,
    };

    setSaving(true);
    const result = await saveClient(user.id, payload);
    setSaving(false);
    if ("error" in result) {
      toast.error(t("Не удалось сохранить: {error}", { error: result.error }));
      return;
    }
    toast.success(t("Профиль обновлён"));
    onSaved(result.row);
    onOpenChange(false);
  };

  const displayName = composeFullName(client) || t("Участник");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl max-h-[92vh] overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle>{t("Редактировать профиль")}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4 py-4">
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
              className="relative focus:outline-none disabled:opacity-70"
              style={{ width: 96, height: 96 }}
              aria-label={t("Загрузить аватар")}
            >
              <SquircleAvatar size={96}>
                {avatarUrl && <SquircleAvatarImage src={avatarUrl} alt={displayName} />}
                <SquircleAvatarFallback className="bg-muted text-foreground text-2xl font-semibold">
                  {initials(displayName)}
                </SquircleAvatarFallback>
              </SquircleAvatar>
              {uploadingAvatar && (
                <div
                  className="absolute inset-0 bg-black/30 flex items-center justify-center"
                  style={{ clipPath: squircleClipPath(96), WebkitClipPath: squircleClipPath(96) }}
                >
                  <Refresh className="h-6 w-6 text-white animate-spin" weight="BoldDuotone" />
                </div>
              )}
              <span className="absolute -bottom-1 -right-1 h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center border-2 border-background">
                <Camera className="h-4 w-4" />
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={AVATAR_ACCEPT}
              className="hidden"
              onChange={handleAvatarChange}
            />
            <button
              type="button"
              className="text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingAvatar}
            >
              {avatarUrl ? t("Заменить фото") : t("Загрузить фото")}
            </button>
          </div>

          <FloatingLabelInput
            label={t("Фамилия")}
            id="last_name"
            value={form.last_name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setForm((f) => ({ ...f, last_name: e.target.value }))
            }
            maxLength={60}
            autoComplete="family-name"
          />

          <FloatingLabelInput
            label={t("Имя")}
            id="first_name"
            value={form.first_name}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setForm((f) => ({ ...f, first_name: e.target.value }))
            }
            maxLength={60}
            autoComplete="given-name"
          />

          {/* Флаг и код страны (по умолчанию +995) и маска номера — PhoneInput. */}
          <PhoneInput
            label={t("Телефон")}
            id="phone"
            value={form.phone}
            onChange={(phone) => setForm((f) => ({ ...f, phone }))}
          />

          <FloatingLabelInput
            label={t("Email")}
            id="email"
            type="email"
            inputMode="email"
            value={form.email}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setForm((f) => ({ ...f, email: e.target.value }))
            }
            maxLength={255}
            autoComplete="email"
          />

          <FloatingLabelInput
            label={t("Дата рождения")}
            id="birthday"
            type="date"
            value={form.birthday}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setForm((f) => ({ ...f, birthday: e.target.value }))
            }
          />

          <FloatingLabelSelect
            label={t("Пол")}
            value={form.gender || "unset"}
            onValueChange={(v: string) =>
              setForm((f) => ({ ...f, gender: v === "unset" ? "" : v }))
            }
          >
            <SelectItem value="unset">{t("Не указано")}</SelectItem>
            <SelectItem value="male">{t("Мужской")}</SelectItem>
            <SelectItem value="female">{t("Женский")}</SelectItem>
          </FloatingLabelSelect>
        </div>

        <SheetFooter className="flex-row gap-2">
          <Button
            variant="outline"
            className="flex-1 shadow-none"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("Отмена")}
          </Button>
          <Button className="flex-1" onClick={handleSave} disabled={saving}>
            {saving && <Refresh className="animate-spin" weight="BoldDuotone" />}
            {t("Сохранить")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

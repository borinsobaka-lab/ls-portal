import { createFileRoute } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Loader2, Save } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import {
  APP_ICON_MIN_SIZE,
  APP_NAME_DEFAULT,
  APP_NAME_FITS,
  APP_NAME_MAX,
  appIconUrl,
  uploadAppIcon,
} from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, InfoNote } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AppSettingsFormSkeleton, AppSettingsPageSkeleton } from "@/components/page-skeletons";
import { cn } from "@/lib/utils";
import { useStudios } from "@/hooks/use-studios";
import {
  STUDIO_FORMATS,
  STUDIO_FORMAT_APP_URL,
  STUDIO_FORMAT_LABEL,
  type StudioFormat,
} from "@/lib/studio-formats";

export const Route = createFileRoute("/_authenticated/app-settings")({
  head: () => ({ meta: [{ title: "Настройки приложения — Base40 Admin" }] }),
  pendingComponent: AppSettingsPageSkeleton,
  component: AppSettingsPage,
});

const TIPS = {
  icon: "Иконка вкладки браузера и значок на рабочем столе, когда клиент сохраняет приложение на телефон или компьютер.",
  name: "Название под значком приложения на рабочем столе телефона или компьютера.",
  signIn:
    "«Вход закрыт» — приложение можно установить, но на экране входа вместо почты клиенты видят текст ниже. Включите, пока переносите базу клиентов.",
};

/**
 * Текст экрана входа при «Вход закрыт» — как в клиентском приложении
 * (apps/client/src/routes/auth.tsx, там же переводы).
 */
const SIGN_IN_CLOSED_TEXT =
  "Спасибо за скачивание нового мобильного приложения. Вход в приложение мы откроем утром, 18 октября.";

type Settings = {
  format: StudioFormat;
  app_name: string | null;
  app_icon_path: string | null;
  /** «Вход закрыт» (db/migrations/2026-10-14_zz_app_sign_in_closed_studio_photo.sql). */
  sign_in_closed: boolean;
};

type FormValues = {
  name: string;
  /** Папка с иконками в бакете app-icons; null — иконка Base40 по умолчанию. */
  iconPath: string | null;
  signInClosed: boolean;
};

function toFormValues(s: Settings | null | undefined): FormValues {
  return {
    name: s?.app_name ?? "",
    iconPath: s?.app_icon_path ?? null,
    signInClosed: s?.sign_in_closed === true,
  };
}

// У каждого клиентского приложения (формата клубов) своя строка —
// app_install_settings (db/migrations/2026-10-11_zzzzzzzzzz_app_content_by_studio.sql).
// Показываем приложения форматов, где у сотрудника есть клубы (так же пускает RLS).
const TABLE = "app_install_settings";
const QUERY_KEY = [TABLE];

const FORM_ID = "app-settings-form";

function AppSettingsPage() {
  const queryClient = useQueryClient();
  const { data: studios = [], isPending: studiosLoading } = useStudios();
  const { data: rows = [], isPending: rowsLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => unwrap<Settings[]>(supabase.from(TABLE).select("*")),
    meta: { errorMessage: "Не удалось загрузить настройки" },
  });
  const loading = studiosLoading || rowsLoading;
  const formats = STUDIO_FORMATS.filter((f) => studios.some((s) => s.format === f));

  // Как в «Контактах и правилах»: правки отдельно от загруженного, пока поле
  // не трогали — форма показывает данные с сервера.
  const [drafts, setDrafts] = useState<Partial<Record<StudioFormat, FormValues>>>({});
  const formOf = (f: StudioFormat) => drafts[f] ?? toFormValues(rows.find((r) => r.format === f));
  const setField = <K extends keyof FormValues>(f: StudioFormat, field: K, value: FormValues[K]) =>
    setDrafts((prev) => ({ ...prev, [f]: { ...formOf(f), ...prev[f], [field]: value } }));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const changed = formats.filter((f) => drafts[f]);
    if (changed.length === 0) {
      toast.success("Настройки сохранены");
      return;
    }
    if (changed.some((f) => formOf(f).name.trim().length > APP_NAME_MAX)) {
      toast.error(`Подпись — не длиннее ${APP_NAME_MAX} символов`);
      return;
    }
    setSaving(true);
    try {
      const saved: Settings[] = changed.map((f) => ({
        format: f,
        app_name: formOf(f).name.trim() || null,
        app_icon_path: formOf(f).iconPath,
        sign_in_closed: formOf(f).signInClosed,
      }));
      const { error } = await supabase.from(TABLE).upsert(
        saved.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
        { onConflict: "format" },
      );
      if (error) {
        toast.error("Не удалось сохранить", { description: error.message });
        return;
      }
      queryClient.setQueryData<Settings[]>(QUERY_KEY, (prev = []) => [
        ...prev.filter((r) => !changed.includes(r.format)),
        ...saved,
      ]);
      setDrafts({});
      toast.success("Настройки сохранены");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminShell
      title="Настройки приложения"
      actions={
        <Button type="submit" form={FORM_ID} disabled={saving || loading || formats.length === 0}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Сохранить
        </Button>
      }
    >
      {loading ? (
        <AppSettingsFormSkeleton />
      ) : formats.length === 0 ? (
        <InfoNote variant="empty" className="max-w-2xl">
          У вас нет клубов — настраивать нечего.
        </InfoNote>
      ) : (
        <form
          id={FORM_ID}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
          className="max-w-2xl space-y-8"
        >
          {formats.map((f) => (
            <AppInstallSection
              key={f}
              format={f}
              clubs={studios.filter((s) => s.format === f).map((s) => s.name)}
              form={formOf(f)}
              onName={(v) => setField(f, "name", v)}
              onIcon={(v) => setField(f, "iconPath", v)}
              onSignInClosed={(v) => setField(f, "signInClosed", v)}
            />
          ))}
          <InfoNote>
            Уже установленные приложения подхватывают новую иконку и подпись не сразу: Android
            проверяет их сам, обычно в течение суток; на iPhone значок обновится только после
            повторного «На экран „Домой“».
          </InfoNote>
        </form>
      )}
    </AdminShell>
  );
}

/** Карточка одного клиентского приложения: вход, иконка, подпись, предпросмотр. */
function AppInstallSection({
  format,
  clubs,
  form,
  onName,
  onIcon,
  onSignInClosed,
}: {
  format: StudioFormat;
  clubs: string[];
  form: FormValues;
  onName: (v: string) => void;
  onIcon: (v: string | null) => void;
  onSignInClosed: (v: boolean) => void;
}) {
  const host = STUDIO_FORMAT_APP_URL[format].replace(/^https?:\/\//, "");
  const shownName = form.name.trim() || APP_NAME_DEFAULT;
  return (
    <section className="space-y-4 rounded-lg border bg-background p-6">
      <div>
        <h2 className="text-lg font-semibold">Приложение {host}</h2>
        <p className="text-sm text-muted-foreground">
          {STUDIO_FORMAT_LABEL[format]}: {clubs.join(", ")}. Как приложение выглядит во вкладке
          браузера и на рабочем столе, когда клиент сохраняет его на телефон или компьютер.
        </p>
      </div>

      <FormField label="Вход в приложение" tip={TIPS.signIn} htmlFor={null}>
        <div className="space-y-3">
          <SegmentedControl
            aria-label="Вход в приложение"
            value={form.signInClosed ? "closed" : "open"}
            onChange={(v) => onSignInClosed(v === "closed")}
            options={[
              { value: "open", label: "Приложение активно" },
              { value: "closed", label: "Вход закрыт" },
            ]}
          />
          {form.signInClosed && (
            <InfoNote>Клиенты видят на экране входа вместо почты: «{SIGN_IN_CLOSED_TEXT}»</InfoNote>
          )}
        </div>
      </FormField>

      <FormField
        label="Иконка приложения"
        tip={TIPS.icon}
        hint={`Квадрат PNG, JPG или SVG от ${APP_ICON_MIN_SIZE}×${APP_ICON_MIN_SIZE} px, без скруглённых углов — телефон скруглит сам. Для Android картинка сама ужимается к центру с полями цвета её фона — края кругом не обрежутся. Без своей — иконка Base40.`}
        htmlFor={null}
      >
        <AppIconField value={form.iconPath} onChange={onIcon} />
      </FormField>

      <FormField
        label="Подпись под значком"
        tip={TIPS.name}
        hint={
          shownName.length > APP_NAME_FITS
            ? `Длиннее ${APP_NAME_FITS} символов — на телефоне подпись обрежется многоточием.`
            : `Пусто — «${APP_NAME_DEFAULT}».`
        }
      >
        <Input
          placeholder={APP_NAME_DEFAULT}
          maxLength={APP_NAME_MAX}
          value={form.name}
          onChange={(e) => onName(e.target.value)}
          className="max-w-80"
        />
      </FormField>

      <HomeScreenPreview iconPath={form.iconPath} name={shownName} host={host} />
    </section>
  );
}

/** Значок приложения: своя иконка или Base40 по умолчанию. */
function AppIcon({ iconPath, className }: { iconPath: string | null; className?: string }) {
  return (
    <img
      src={iconPath ? appIconUrl(iconPath, "icon192") : "/icon-192.png"}
      alt=""
      className={cn("object-cover", className)}
    />
  );
}

/** Превью + «Загрузить/Заменить» + «Вернуть Base40». */
function AppIconField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (path: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      onChange(await uploadAppIcon(file));
    } catch (err) {
      toast.error("Ошибка загрузки: " + (err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[22%] border bg-muted text-muted-foreground">
        {uploading ? (
          <ImageIcon className="h-4 w-4" />
        ) : (
          <AppIcon iconPath={value} className="h-full w-full" />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) upload(file);
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <>
              <Loader2 className="animate-spin" /> Загрузка…
            </>
          ) : value ? (
            "Заменить"
          ) : (
            "Загрузить"
          )}
        </Button>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Вернуть иконку Base40
          </Button>
        )}
      </div>
    </div>
  );
}

/** Как значок будет выглядеть на рабочем столе телефона и во вкладке браузера. */
function HomeScreenPreview({
  iconPath,
  name,
  host,
}: {
  iconPath: string | null;
  name: string;
  host: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase text-muted-foreground">Предпросмотр</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex h-36 w-44 items-center justify-center rounded-xl bg-gradient-to-br from-slate-700 via-slate-800 to-slate-950">
          <div className="flex w-[72px] flex-col items-center gap-1.5">
            <AppIcon iconPath={iconPath} className="h-14 w-14 rounded-[22%] shadow-md" />
            <span className="w-full truncate text-center text-[11px] leading-tight text-white">
              {name}
            </span>
          </div>
        </div>
        <div className="flex h-9 w-56 items-center gap-2 rounded-t-lg border border-b-0 bg-muted/60 px-3">
          <AppIcon iconPath={iconPath} className="h-4 w-4 rounded-sm" />
          <span className="truncate text-xs text-foreground">{host}</span>
        </div>
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, LogIn, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { ContentLangLabel, ContentLangNote, ContentLangSwitch } from "@/components/content-lang";
import { ImageUploadField, StorageImage } from "@/components/image-upload-field";
import { RowContextMenu } from "@/components/row-context-menu";
import { useTableSort } from "@/hooks/use-table-sort";
import { TableSkeletonRows } from "@/components/skeletons";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { ColorInput } from "@/components/ui/color-input";
import { FormField, InfoNote } from "@/components/ui/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { setActiveStudioId, useActiveStudioId } from "@/hooks/use-active-studio";
import { useContentTranslations } from "@/hooks/use-content-translations";
import { useStudios, type Studio } from "@/hooks/use-studios";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { supabase } from "@/integrations/supabase/client";
import { squareImage, useStorageUrl } from "@/lib/storage";
import { cn } from "@/lib/utils";
import {
  DEFAULT_BRAND_COLOR,
  STUDIO_FORMATS,
  STUDIO_FORMAT_APP_URL,
  STUDIO_FORMAT_LABEL,
  isBrandColor,
  type StudioFormat,
} from "@/lib/studio-formats";
import { StudiosPageSkeleton } from "@/components/page-skeletons";
import { DeleteStudioForm } from "@/components/studio-delete-form";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  format:
    "От типа зависят абонементы, тренировки и расписание клуба, а клиенты пользуются приложением этого типа.",
  color: "Цвет иконки активного пункта меню и акцентов админки, пока открыт этот клуб.",
  logo: "Показывается в шапке бокового меню. Без логотипа там будет название клуба.",
  address: "Клиенты видят его в приложении под названием клуба — на главной и в выборе клуба.",
  photo:
    "Маленькая картинка слева от названия клуба в приложении клиентов, когда они выбирают студию («Сменить студию» на главной).",
};

/** Колонка и подписи «Приложение клиентов» — только когда адрес задан (VITE_*_APP_URL). */
const SHOW_APPS = STUDIO_FORMATS.some((f) => !!STUDIO_FORMAT_APP_URL[f]);

export const Route = createFileRoute("/_authenticated/studios")({
  head: () => ({ meta: [{ title: "Клубы — Lady Stretch" }] }),
  pendingComponent: StudiosPageSkeleton,
  component: StudiosPage,
});

/**
 * Студии сети. Каждая студия — в переключателе в шапке; у студии формат
 * (STUDIO_FORMATS.md), логотип в меню и основной цвет админки.
 * Создаёт студию владелец любой студии (RPC create_studio — он же становится
 * владельцем новой), правит и удаляет — владелец этой студии (RPC
 * delete_studio, db/migrations/2026-10-10_studio_delete.sql).
 */
function StudiosPage() {
  const { data: studios = [], isLoading } = useStudios();
  const activeId = useActiveStudioId();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Studio | null>(null);
  const [deleting, setDeleting] = useState<Studio | null>(null);
  const access = useAdminAccess();
  const sort = useTableSort<Studio>({
    name: (s) => s.name,
    format: (s) => STUDIO_FORMAT_LABEL[s.format],
    color: (s) => s.brand_color,
    app: (s) => STUDIO_FORMAT_APP_URL[s.format],
  });

  // Создать клуб — право «Создаёт клубы» (раньше — любой владелец клуба).
  const canCreate = hasRight(access, "studios.create");
  const reload = () => queryClient.invalidateQueries({ queryKey: ["studios"] });

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };

  return (
    <AdminShell
      title="Клубы"
      actions={
        canCreate ? (
          <Button onClick={openCreate}>
            <Plus />
            Добавить клуб
          </Button>
        ) : null
      }
    >
      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead {...sort.head("name")}>Название</TableHead>
              <TableHead className="w-[180px]" tip={TIPS.logo}>
                Логотип
              </TableHead>
              <TableHead tip={TIPS.format} {...sort.head("format")}>
                Тип
              </TableHead>
              <TableHead tip={TIPS.color} {...sort.head("color")}>
                Цвет
              </TableHead>
              {SHOW_APPS && <TableHead {...sort.head("app")}>Приложение клиентов</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeletonRows columns={SHOW_APPS ? 5 : 4} rows={2} />
            ) : studios.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={SHOW_APPS ? 5 : 4}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Нет клубов, где вы сотрудник.
                </TableCell>
              </TableRow>
            ) : (
              sort.apply(studios).map((s) => {
                const isOwner = s.roles.includes("owner");
                return (
                  <RowContextMenu
                    key={s.id}
                    actions={[
                      ...(s.id !== activeId
                        ? [
                            {
                              label: "Перейти в клуб",
                              icon: LogIn,
                              onSelect: () => setActiveStudioId(s.id),
                            },
                          ]
                        : []),
                      ...(isOwner
                        ? [
                            {
                              label: "Редактировать",
                              icon: Pencil,
                              onSelect: () => {
                                setEditing(s);
                                setOpen(true);
                              },
                            },
                            {
                              label: "Удалить клуб",
                              icon: Trash2,
                              destructive: true,
                              onSelect: () => setDeleting(s),
                            },
                          ]
                        : []),
                    ]}
                  >
                    <TableRow>
                      <TableCell className="font-medium">
                        {s.name}
                        {s.id === activeId && (
                          <Badge variant="secondary" className="ml-2">
                            Открыт
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <LogoPreview value={s.logo_url} name={s.name} compact />
                      </TableCell>
                      <TableCell>{STUDIO_FORMAT_LABEL[s.format]}</TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-2 font-mono text-xs uppercase">
                          <span
                            className="size-4 rounded-full border"
                            style={{ backgroundColor: s.brand_color }}
                          />
                          {s.brand_color}
                        </span>
                      </TableCell>
                      {SHOW_APPS && (
                        <TableCell>
                          <a
                            href={STUDIO_FORMAT_APP_URL[s.format]}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-link underline-offset-4 hover:text-link-hover hover:underline"
                          >
                            {STUDIO_FORMAT_APP_URL[s.format].replace(/^https?:\/\//, "")}
                            <ExternalLink className="size-3.5" />
                          </a>
                        </TableCell>
                      )}
                    </TableRow>
                  </RowContextMenu>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
          <StudioForm
            key={editing?.id ?? "new"}
            item={editing}
            onClose={() => setOpen(false)}
            onSaved={reload}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent className="max-w-lg">
          {deleting && (
            <DeleteStudioForm
              key={deleting.id}
              studio={deleting}
              onClose={() => setDeleting(null)}
              onDeleted={() => {
                // Данные удалённой студии лежат во многих кэшах — сбрасываем
                // всё; активную студию StudioBranding сам переключит на другую.
                queryClient.invalidateQueries();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </AdminShell>
  );
}

/** Логотип на подложке цвета меню — так, как он будет выглядеть в админке. */
function LogoPreview({
  value,
  name,
  compact,
}: {
  value: string | null;
  name: string;
  /** В строке таблицы — ниже, в форме — превью h-16 по стандарту. */
  compact?: boolean;
}) {
  const src = useStorageUrl("studios", value);
  return (
    <div
      className={cn(
        "flex w-40 shrink-0 items-center rounded-md bg-sidebar px-3 text-sidebar-foreground",
        compact ? "h-10" : "h-16",
      )}
    >
      {src ? (
        <img
          src={src}
          alt={name}
          className={cn(
            "h-auto w-full object-contain object-left",
            compact ? "max-h-7" : "max-h-12",
          )}
        />
      ) : (
        <span className="truncate text-sm font-semibold">{name}</span>
      )}
    </div>
  );
}

function StudioForm({
  item,
  onClose,
  onSaved,
}: {
  item: Studio | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item?.name ?? "");
  const [format, setFormat] = useState<StudioFormat>(item?.format ?? "subscription");
  const [color, setColor] = useState(item?.brand_color ?? DEFAULT_BRAND_COLOR);
  const [logo, setLogo] = useState<string | null>(item?.logo_url ?? null);
  const [address, setAddress] = useState(item?.address ?? "");
  const [photo, setPhoto] = useState<string | null>(item?.photo_url ?? null);
  const tr = useContentTranslations(item?.translations);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) {
      tr.setLang("ru");
      toast.error("Укажите название клуба");
      return;
    }
    if (!isBrandColor(color)) {
      toast.error("Цвет — в формате #RRGGBB, например #F763FC");
      return;
    }
    setSaving(true);
    try {
      const brandColor = color.toLowerCase();
      // Формат после создания не меняется: под ним у студии свои абонементы,
      // расписание и данные, переключение — это миграция, а не правка поля.
      const addressValue = address.trim() || null;
      const translations = tr.cleaned();
      let error;
      if (item) {
        ({ error } = await supabase
          .from("studios")
          .update({
            name: name.trim(),
            brand_color: brandColor,
            logo_url: logo,
            address: addressValue,
            photo_url: photo,
            translations,
          })
          .eq("id", item.id));
      } else {
        const created = await supabase.rpc("create_studio", {
          _name: name.trim(),
          _format: format,
          _brand_color: brandColor,
          _logo_url: logo,
        });
        error = created.error;
        // create_studio адрес, картинку и переводы не принимает — дописываем:
        // создатель уже владелец новой студии и может её править.
        if (
          !error &&
          (addressValue || photo || Object.keys(translations).length > 0) &&
          created.data
        ) {
          ({ error } = await supabase
            .from("studios")
            .update({ address: addressValue, photo_url: photo, translations })
            .eq("id", created.data as string));
        }
      }
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success(
        item ? "Клуб сохранён" : "Клуб создан — переключиться на него можно в выборе клуба",
      );
      onClose();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const appHost = (f: StudioFormat) => STUDIO_FORMAT_APP_URL[f].replace(/^https?:\/\//, "");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? "Редактировать клуб" : "Новый клуб"}</DialogTitle>
        <DialogDescription>
          Логотип и основной цвет видны в админке, пока открыт этот клуб.
        </DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            <FormField
              label={<ContentLangLabel lang={tr.lang}>Название</ContentLangLabel>}
              required={tr.lang === "ru"}
            >
              <Input {...tr.input("name", name, setName, "Lady Stretch Москва")} />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Адрес</ContentLangLabel>}
              optional
              tip={TIPS.address}
            >
              <Input {...tr.input("address", address, setAddress, "Тбилиси, ул. Палиашвили, 40")} />
            </FormField>

            {item ? (
              <InfoNote>
                Тип:{" "}
                <span className="font-medium text-foreground">{STUDIO_FORMAT_LABEL[format]}</span>.
                Тип задаётся при создании и не меняется.
                {SHOW_APPS && ` Приложение клиентов — ${appHost(format)}.`}
              </InfoNote>
            ) : (
              <FormField
                label="Тип клуба"
                required
                tip={TIPS.format}
                hint={`${SHOW_APPS ? `Приложение клиентов — ${appHost(format)}. ` : ""}После создания тип не меняется.`}
              >
                <Select value={format} onValueChange={(v) => setFormat(v as StudioFormat)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STUDIO_FORMATS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {STUDIO_FORMAT_LABEL[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}

            <FormField
              label="Основной цвет"
              htmlFor={null}
              required
              tip={TIPS.color}
              hint="В формате #RRGGBB."
            >
              <ColorInput value={color} onChange={setColor} fallback={DEFAULT_BRAND_COLOR} />
            </FormField>

            <FormField
              label="Логотип"
              htmlFor={null}
              optional
              tip={TIPS.logo}
              hint="Меню тёмное — нужен светлый логотип на прозрачном фоне, SVG или PNG."
            >
              <ImageUploadField
                bucket="studios"
                folder={item?.id ?? "new"}
                value={logo}
                onChange={setLogo}
                preview={<LogoPreview value={logo} name={name || "Название"} />}
                accept="image/svg+xml,image/png,image/webp"
              />
            </FormField>

            <FormField
              label="Картинка в приложении"
              htmlFor={null}
              optional
              tip={TIPS.photo}
              hint="Квадратная: обрежется по центру и уменьшится до 256×256 px."
            >
              <ImageUploadField
                bucket="studios"
                folder={`${item?.id ?? "new"}/photo`}
                value={photo}
                onChange={setPhoto}
                prepare={(f) => squareImage(f, 256)}
                accept="image/png,image/jpeg,image/webp"
                preview={
                  <StorageImage
                    bucket="studios"
                    value={photo}
                    alt={name || "Клуб"}
                    className="size-16 rounded-lg"
                  />
                }
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {item ? "Сохранить" : "Создать клуб"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

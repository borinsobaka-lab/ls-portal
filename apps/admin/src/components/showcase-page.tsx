import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Loader2, Pencil, Trash2, ArrowUp, ArrowDown } from "lucide-react";

import { AdminShell } from "@/components/admin-shell";
import { ImageUploadField, StorageImage } from "@/components/image-upload-field";
import { supabase } from "@/integrations/supabase/client";
import { unwrap } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import { Textarea } from "@/components/ui/textarea";
import { FormattedTextarea } from "@/components/formatted-textarea";
import { ContentLangLabel, ContentLangNote, ContentLangSwitch } from "@/components/content-lang";
import { useContentTranslations } from "@/hooks/use-content-translations";
import type { ContentTranslations } from "@/lib/content-i18n";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { DataPagination, usePagination } from "@/components/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import type { SortGetters } from "@/lib/table-sort";
import { TableSkeletonRows } from "@/components/skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { RowContextMenu } from "@/components/row-context-menu";
import { AppStudiosField, StudioNamesCell } from "@/components/app-studios-field";
import { splitStudioIds, useDefaultStudioIds, useMyStudioIds } from "@/hooks/use-app-studios";

/** Подсказки «?»: один текст у поля формы и у колонки таблицы. */
const TIPS = {
  image: "В списке на главном экране приложения. Если нет баннера — и вверху открытой страницы.",
  banner: "Широкая картинка вверху открытой страницы. Не задан — там будет превью.",
  studios: "Клиенты каких клубов увидят карточку в приложении.",
};

/**
 * Раздел витрины мобильного приложения — карточки с картинкой, баннером,
 * текстом и кнопкой-ссылкой, в заданном порядке. «Новости» и «Услуги» —
 * одна и та же сущность в разных таблицах; страницы отличаются только
 * текстами (ShowcaseConfig), поэтому вся логика здесь, а news.tsx и
 * services.tsx лишь описывают свой раздел.
 */
export type ShowcaseConfig = {
  table: "news" | "services";
  bucket: "news" | "services";
  title: string;
  /** Тексты с названием карточки в нужном падеже. */
  texts: {
    loadError: string;
    deleteTitle: string;
    deleted: string;
    add: string;
    empty: string;
    added: string;
    updated: string;
    createTitle: string;
    editTitle: string;
    dialogDescription: string;
    fullTitlePlaceholder: string;
    fullTextPlaceholder: string;
    /** «…под новостью появится кнопка-ссылка» */
    buttonHint: string;
    buttonPlaceholder: string;
  };
  /** Ширина колонки «Описание» в таблице. */
  descriptionWidth: string;
  /** Требовать заполнить текст и ссылку кнопки вместе (или оставить оба пустыми). */
  requireButtonPair: boolean;
};

type ShowcaseItem = {
  id: string;
  /** Клубы, в приложении которых карточка показывается. */
  studio_ids: string[];
  position: number;
  image_url: string | null;
  banner_url: string | null;
  title: string;
  description: string | null;
  full_title: string | null;
  full_text: string | null;
  button_text: string | null;
  button_url: string | null;
  /** Переводы для приложения: {en|ka: {title, description, full_title, full_text, button_text}}. */
  translations: ContentTranslations;
  created_at: string;
};

/** Сортировка колонок (lib/table-sort.ts). */
const SORT_GETTERS: SortGetters<ShowcaseItem> = {
  position: (n) => n.position,
  image: (n) => Boolean(n.image_url),
  banner: (n) => Boolean(n.banner_url),
  title: (n) => n.title,
  description: (n) => n.description,
  button: (n) => (n.button_text && n.button_url ? n.button_text : null),
};

export function ShowcasePage({ config }: { config: ShowcaseConfig }) {
  const { table, bucket, texts } = config;
  const { confirm, confirmDialog } = useConfirm();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ShowcaseItem | null>(null);
  const [reordering, setReordering] = useState(false);

  // Записи, где есть хоть один мой клуб (их же пускает править RLS).
  const myStudioIds = useMyStudioIds();
  const queryKey = [table, "by-studios", myStudioIds?.join(",") ?? ""];
  const { data: items = [], isPending: loading } = useQuery({
    queryKey,
    queryFn: () =>
      unwrap<ShowcaseItem[]>(
        supabase
          .from(table)
          .select("*")
          .overlaps("studio_ids", myStudioIds ?? [])
          .order("position", { ascending: true })
          .order("created_at", { ascending: false }),
      ),
    enabled: !!myStudioIds,
    meta: { errorMessage: texts.loadError },
  });
  const reload = () => queryClient.invalidateQueries({ queryKey: [table] });

  const handleDelete = async (n: ShowcaseItem) => {
    // Удалить можно только из своих клубов целиком (RLS молча не удалит).
    const { locked } = splitStudioIds(n.studio_ids, myStudioIds);
    if (locked.length > 0) {
      toast.error("Удалить нельзя: карточка есть и в клубах, к которым у вас нет доступа", {
        description: "Уберите из неё свои клубы в «Редактировать» — у вас она пропадёт.",
      });
      return;
    }
    if (
      !(await confirm({
        title: texts.deleteTitle,
        description: `«${n.title}» пропадёт из приложения клиентов.`,
      }))
    )
      return;
    const { error } = await supabase.from(table).delete().eq("id", n.id);
    if (error) {
      toast.error("Ошибка удаления: " + error.message);
      return;
    }
    toast.success(texts.deleted);
    reload();
  };

  // Меняет местами позиции соседних строк. Через временную позицию — на случай
  // будущего уникального индекса по position.
  const swap = async (a: ShowcaseItem, b: ShowcaseItem) => {
    setReordering(true);
    try {
      const tmp = -1 - Math.floor(Math.random() * 1000);
      const r1 = await supabase.from(table).update({ position: tmp }).eq("id", a.id);
      if (r1.error) {
        toast.error("Ошибка: " + r1.error.message);
        return;
      }
      const r2 = await supabase.from(table).update({ position: a.position }).eq("id", b.id);
      const r3 = await supabase.from(table).update({ position: b.position }).eq("id", a.id);
      if (r2.error || r3.error) {
        toast.error("Ошибка изменения порядка");
        reload();
        return;
      }
      const swapped = new Map([
        [a.id, b.position],
        [b.id, a.position],
      ]);
      queryClient.setQueryData<ShowcaseItem[]>(queryKey, (prev) =>
        prev
          ?.map((x) => ({ ...x, position: swapped.get(x.id) ?? x.position }))
          .sort((x, y) => x.position - y.position),
      );
    } finally {
      setReordering(false);
    }
  };

  const move = (idx: number, dir: -1 | 1) => {
    const other = items[idx + dir];
    if (other) swap(items[idx], other);
  };

  const openCreate = () => {
    setEditing(null);
    setOpen(true);
  };
  const openEdit = (n: ShowcaseItem) => {
    setEditing(n);
    setOpen(true);
  };

  const sort = useTableSort(SORT_GETTERS);
  // Стрелки порядка — только в порядке приложения: при сортировке по колонке
  // «выше/ниже» на экране не совпадало бы с соседом по position.
  const canReorder = !sort.sort;
  const pg = usePagination(sort.apply(items), undefined, sort.key);

  return (
    <AdminShell
      title={config.title}
      actions={
        <Button onClick={openCreate}>
          <Plus />
          {texts.add}
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[90px]" {...sort.head("position")}>
                  Порядок
                </TableHead>
                <TableHead className="w-[100px]" tip={TIPS.image} {...sort.head("image")}>
                  Картинка
                </TableHead>
                <TableHead className="w-[140px]" tip={TIPS.banner} {...sort.head("banner")}>
                  Баннер
                </TableHead>
                <TableHead {...sort.head("title")}>Заголовок</TableHead>
                <TableHead className="w-[180px]" tip={TIPS.studios}>
                  Клубы
                </TableHead>
                <TableHead {...sort.head("description")}>Описание</TableHead>
                <TableHead className="w-[140px]" {...sort.head("button")}>
                  Кнопка
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableSkeletonRows columns={7} />
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">
                    {texts.empty}
                  </TableCell>
                </TableRow>
              ) : (
                pg.paged.map((n) => {
                  const idx = items.indexOf(n);
                  return (
                    <RowContextMenu
                      key={n.id}
                      actions={[
                        { label: "Редактировать", icon: Pencil, onSelect: () => openEdit(n) },
                        {
                          label: "Удалить",
                          icon: Trash2,
                          destructive: true,
                          onSelect: () => handleDelete(n),
                        },
                      ]}
                    >
                      <TableRow>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!canReorder || idx === 0 || reordering}
                              onClick={() => move(idx, -1)}
                              aria-label="Выше"
                            >
                              <ArrowUp />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={!canReorder || idx === items.length - 1 || reordering}
                              onClick={() => move(idx, 1)}
                              aria-label="Ниже"
                            >
                              <ArrowDown />
                            </Button>
                            <span className="ml-1 w-5 text-xs text-muted-foreground tabular-nums">
                              {idx + 1}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <StorageImage bucket={bucket} value={n.image_url} alt={n.title} />
                        </TableCell>
                        <TableCell>
                          <StorageImage
                            bucket={bucket}
                            value={n.banner_url}
                            alt={n.title}
                            className="h-10 w-28"
                          />
                        </TableCell>
                        <TableCell className="font-medium">{n.title}</TableCell>
                        <TableCell>
                          <StudioNamesCell ids={n.studio_ids} />
                        </TableCell>
                        <TableCell
                          className="truncate text-muted-foreground"
                          style={{ maxWidth: config.descriptionWidth }}
                        >
                          {n.description ?? "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {n.button_text && n.button_url ? n.button_text : "—"}
                        </TableCell>
                      </TableRow>
                    </RowContextMenu>
                  );
                })
              )}
            </TableBody>
          </Table>
          <DataPagination {...pg} loading={loading} />
        </div>
      </div>

      <ShowcaseDialog
        config={config}
        open={open}
        onOpenChange={setOpen}
        item={editing}
        nextPosition={items.length > 0 ? Math.max(...items.map((i) => i.position)) + 1 : 0}
        onSaved={reload}
      />
      {confirmDialog}
    </AdminShell>
  );
}

type DialogProps = {
  config: ShowcaseConfig;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item: ShowcaseItem | null;
  nextPosition: number;
  onSaved: () => void;
};

function ShowcaseDialog(props: DialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-2xl">
        {/* Форма монтируется заново при каждом открытии — сбрасывать её не нужно. */}
        <ShowcaseForm key={props.item?.id ?? "new"} {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ShowcaseForm({ config, onOpenChange, item, nextPosition, onSaved }: DialogProps) {
  const { table, bucket, texts } = config;
  const defaultStudioIds = useDefaultStudioIds();
  const split = splitStudioIds(item?.studio_ids ?? [], useMyStudioIds());
  const [studioIds, setStudioIds] = useState(item ? split.mine : defaultStudioIds);
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [fullTitle, setFullTitle] = useState(item?.full_title ?? "");
  const [fullText, setFullText] = useState(item?.full_text ?? "");
  const [buttonText, setButtonText] = useState(item?.button_text ?? "");
  const [buttonUrl, setButtonUrl] = useState(item?.button_url ?? "");
  const [imageUrl, setImageUrl] = useState(item?.image_url ?? null);
  const [bannerUrl, setBannerUrl] = useState(item?.banner_url ?? null);
  const tr = useContentTranslations(item?.translations);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!title.trim()) {
      tr.setLang("ru");
      toast.error("Укажите заголовок");
      return;
    }
    // Убрать все свои клубы у карточки, которая есть и в чужих, можно —
    // у нас она пропадёт; новая же без клубов никому не видна.
    if (studioIds.length === 0 && split.locked.length === 0) {
      toast.error("Выберите хотя бы один клуб");
      return;
    }
    const bt = buttonText.trim();
    const bu = buttonUrl.trim();
    if (config.requireButtonPair && !bt !== !bu) {
      tr.setLang("ru");
      toast.error("Заполните оба поля кнопки или оставьте оба пустыми");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        full_title: fullTitle.trim() || null,
        full_text: fullText.trim() || null,
        button_text: bt || null,
        button_url: bu || null,
        image_url: imageUrl,
        banner_url: bannerUrl,
        translations: tr.cleaned(),
        studio_ids: [...studioIds, ...split.locked],
        updated_at: new Date().toISOString(),
      };
      const { error } = item
        ? await supabase.from(table).update(payload).eq("id", item.id)
        : await supabase.from(table).insert({ ...payload, position: nextPosition });
      if (error) {
        toast.error("Ошибка сохранения: " + error.message);
        return;
      }
      toast.success(item ? texts.updated : texts.added);
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{item ? texts.editTitle : texts.createTitle}</DialogTitle>
        <DialogDescription>{texts.dialogDescription}</DialogDescription>
        <ContentLangSwitch tr={tr} />
      </DialogHeader>
      <DialogForm onSubmit={handleSave}>
        <DialogBody>
          <div className="space-y-4">
            <ContentLangNote lang={tr.lang} />
            <AppStudiosField
              value={studioIds}
              onChange={setStudioIds}
              locked={split.locked}
              tip={TIPS.studios}
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField label="Картинка (превью)" tip={TIPS.image} htmlFor={null} optional>
                <ImageUploadField
                  bucket={bucket}
                  folder="app/image"
                  value={imageUrl}
                  onChange={setImageUrl}
                />
              </FormField>

              <FormField label="Баннер" tip={TIPS.banner} htmlFor={null} optional>
                <ImageUploadField
                  bucket={bucket}
                  folder="app/banner"
                  value={bannerUrl}
                  onChange={setBannerUrl}
                  preview={
                    <StorageImage
                      bucket={bucket}
                      value={bannerUrl}
                      alt="Баннер"
                      className="h-16 w-40"
                    />
                  }
                />
              </FormField>
            </div>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Заголовок</ContentLangLabel>}
              required={tr.lang === "ru"}
            >
              <Input {...tr.input("title", title, setTitle, "Краткий заголовок для списка")} />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Описание</ContentLangLabel>}
              tip="Строка под заголовком в списке на главном экране — без форматирования."
              optional
            >
              <Textarea
                rows={2}
                {...tr.input(
                  "description",
                  description,
                  setDescription,
                  "Короткое описание для превью",
                )}
              />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Полный заголовок</ContentLangLabel>}
              tip="Вверху открытой страницы. Пусто — возьмётся обычный заголовок."
              optional
            >
              <Input
                {...tr.input("full_title", fullTitle, setFullTitle, texts.fullTitlePlaceholder)}
              />
            </FormField>

            <FormField
              label={<ContentLangLabel lang={tr.lang}>Полный текст</ContentLangLabel>}
              tip="На открытой странице. Можно выделять жирным, делать списки и ссылки."
              optional
            >
              <FormattedTextarea
                rows={8}
                {...tr.text("full_text", fullText, setFullText, texts.fullTextPlaceholder)}
              />
            </FormField>

            <div className="space-y-3 rounded-md border p-3">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  Кнопка перехода
                </div>
                <p className="text-xs text-muted-foreground">
                  {texts.buttonHint} Если пусто — кнопки не будет.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <FormField
                  label={<ContentLangLabel lang={tr.lang}>Текст на кнопке</ContentLangLabel>}
                  required={tr.lang === "ru" && config.requireButtonPair && !!buttonUrl.trim()}
                >
                  <Input
                    {...tr.input("button_text", buttonText, setButtonText, texts.buttonPlaceholder)}
                  />
                </FormField>
                <FormField
                  label="Ссылка"
                  required={config.requireButtonPair && !!buttonText.trim()}
                >
                  <Input
                    value={buttonUrl}
                    onChange={(e) => setButtonUrl(e.target.value)}
                    placeholder="https://…"
                  />
                </FormField>
              </div>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

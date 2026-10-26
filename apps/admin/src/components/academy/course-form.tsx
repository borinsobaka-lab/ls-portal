import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ImagePlus, Loader2, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { CourseCover } from "@/components/academy/parts";
import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField, SwitchRow } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { acadCourseFolder, acadFoldersQuery, invalidateAcademy } from "@/lib/academy/data";
import { acadError } from "@/lib/academy/logic";
import type { AcadCourse } from "@/lib/academy/types";
import { KbFileTooLarge, uploadKbFile } from "@/lib/kb/files";

const TIPS = {
  folder:
    "Папки — разделы каталога курсов («Администраторы», «Тренеры»…). Новую можно завести прямо в списке, порядок и названия — в «Настройках» Академии.",
  pass: "Сколько процентов баллов нужно набрать, чтобы тест считался сданным. У отдельного теста можно задать свой.",
  sequential:
    "Включено — следующий шаг открывается, когда пройден предыдущий (тест на проверке у тренера не держит). Выключено — шаги в любом порядке.",
  cover:
    "Картинка на карточке курса у учеников — горизонтальная 16:9 (например, 1600×900), показывается целиком. Текст на ней — крупный: в каталоге обложка маленькая.",
  due: "Подставится в окне «Назначить» — не нужно выставлять срок каждый раз, если назначать курс частями. Уже сделанные назначения не меняются.",
};

const NO_FOLDER = "none";
const NEW_FOLDER = "new";

/**
 * Новый курс или его настройки (право «Создаёт курсы»; RLS —
 * acad_can_create). Обложка — в папку курса в kb-media: у нового курса id
 * придумываем заранее, чтобы загрузить её до сохранения.
 */
export function AcadCourseForm({
  course,
  onDone,
}: {
  course: AcadCourse | null;
  onDone: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const { data: folders } = useQuery(acadFoldersQuery);
  const [id] = useState(() => course?.id ?? crypto.randomUUID());
  const [title, setTitle] = useState(course?.title ?? "");
  const [description, setDescription] = useState(course?.description ?? "");
  const [folderId, setFolderId] = useState(course?.folder_id ?? NO_FOLDER);
  const [pass, setPass] = useState(String(course?.pass_percent ?? 80));
  const [sequential, setSequential] = useState(course?.sequential ?? true);
  const [dueDays, setDueDays] = useState(
    course?.default_due_days ? String(course.default_due_days) : "",
  );
  // «+ Новая папка» прямо в списке, без похода в «Настройки».
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [cover, setCover] = useState(course?.cover ?? null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const uploadCover = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Обложка — картинка (JPG, PNG, WebP)");
      return;
    }
    setUploading(true);
    try {
      setCover(await uploadKbFile(acadCourseFolder(id), file));
    } catch (e) {
      toast.error(
        e instanceof KbFileTooLarge ? e.message : `Не удалось загрузить: ${(e as Error).message}`,
      );
    } finally {
      setUploading(false);
    }
  };

  const createFolder = async () => {
    const t = (folderDraft ?? "").trim();
    if (!t) {
      toast.error("Укажите название папки");
      return;
    }
    setCreatingFolder(true);
    try {
      const order = (folders ?? []).reduce((m, f) => Math.max(m, f.sort_order), 0) + 1;
      const { data, error } = await supabase
        .from("acad_folders")
        .insert({ title: t, sort_order: order })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      await invalidateAcademy(qc);
      setFolderId((data as { id: string }).id);
      setFolderDraft(null);
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setCreatingFolder(false);
    }
  };

  const save = async () => {
    const t = title.trim();
    const p = Number(pass);
    const days = dueDays.trim() ? Number(dueDays) : null;
    if (!t) {
      toast.error("Укажите название курса");
      return;
    }
    if (!Number.isInteger(p) || p < 1 || p > 100) {
      toast.error("Проходной процент — от 1 до 100");
      return;
    }
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) {
      toast.error("Срок по умолчанию — от 1 до 365 дней или пусто");
      return;
    }
    setSaving(true);
    try {
      const row = {
        title: t,
        description: description.trim(),
        folder_id: folderId === NO_FOLDER ? null : folderId,
        pass_percent: p,
        sequential,
        default_due_days: days,
        cover,
      };
      const { error } = course
        ? await supabase.from("acad_courses").update(row).eq("id", course.id)
        : await supabase.from("acad_courses").insert({ id, ...row });
      if (error) throw new Error(error.message);
      toast.success(course ? "Курс сохранён" : "Курс создан — добавьте уроки и тесты");
      await invalidateAcademy(qc);
      onDone(id);
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{course ? "Настройки курса" : "Новый курс"}</DialogTitle>
        <DialogDescription>
          Курс собирается из уроков и тестов. Ученики увидят его после публикации и назначения.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <FormField label="Название" required>
              <Input
                value={title}
                maxLength={200}
                placeholder="Например, «Стандарты администратора»"
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormField>
            <FormField label="Описание" optional>
              <Textarea
                value={description}
                maxLength={2000}
                rows={3}
                placeholder="Чему научится сотрудник"
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FormField
                label="Папка"
                tip={TIPS.folder}
                htmlFor={folderDraft === null ? undefined : null}
              >
                {folderDraft === null ? (
                  <Select
                    value={folderId}
                    onValueChange={(v) => (v === NEW_FOLDER ? setFolderDraft("") : setFolderId(v))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_FOLDER}>Без папки</SelectItem>
                      {(folders ?? []).map((f) => (
                        <SelectItem key={f.id} value={f.id}>
                          {f.title}
                        </SelectItem>
                      ))}
                      <SelectItem value={NEW_FOLDER} className="font-medium text-brand-on-light">
                        {/* ItemText — блочный: без своей строки плюс встаёт над подписью. */}
                        <span className="inline-flex items-center gap-1.5">
                          <Plus className="size-4" /> Новая папка
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-1">
                    <Input
                      autoFocus
                      aria-label="Название новой папки"
                      value={folderDraft}
                      maxLength={80}
                      placeholder="Название папки"
                      disabled={creatingFolder}
                      onChange={(e) => setFolderDraft(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter — создать папку, а не сохранить весь курс.
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void createFolder();
                        }
                      }}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Создать папку"
                      disabled={creatingFolder}
                      onClick={() => void createFolder()}
                    >
                      {creatingFolder ? <Loader2 className="animate-spin" /> : <Check />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Не создавать папку"
                      disabled={creatingFolder}
                      onClick={() => setFolderDraft(null)}
                    >
                      <X />
                    </Button>
                  </div>
                )}
              </FormField>
              <FormField label="Проходной процент" tip={TIPS.pass} required>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                />
              </FormField>
            </div>
            <SwitchRow
              title="Проходить по порядку"
              tip={TIPS.sequential}
              checked={sequential}
              onCheckedChange={setSequential}
            />
            <FormField label="Срок по умолчанию" tip={TIPS.due} optional htmlFor={null}>
              <div className="flex items-center gap-2 text-sm">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={365}
                  className="w-24"
                  aria-label="Срок по умолчанию, дней"
                  placeholder="—"
                  value={dueDays}
                  onChange={(e) => setDueDays(e.target.value)}
                />
                дней с назначения
              </div>
            </FormField>
            <FormField label="Обложка" tip={TIPS.cover} optional htmlFor={null}>
              <div className="flex items-center gap-3">
                <CourseCover cover={cover} className="aspect-[16/9] w-40 shrink-0 rounded-md" />
                <div className="flex flex-col gap-2">
                  <Button asChild variant="outline" size="sm">
                    <label className="cursor-pointer">
                      {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
                      {cover ? "Заменить" : "Загрузить"}
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        disabled={uploading}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void uploadCover(f);
                        }}
                      />
                    </label>
                  </Button>
                  {cover && (
                    <Button variant="ghost" size="sm" onClick={() => setCover(null)}>
                      <Trash2 /> Убрать
                    </Button>
                  )}
                </div>
              </div>
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onDone(null)} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving || uploading}>
            {saving && <Loader2 className="animate-spin" />}
            {course ? "Сохранить" : "Создать"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

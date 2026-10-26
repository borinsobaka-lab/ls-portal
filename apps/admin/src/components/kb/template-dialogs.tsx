import { lazy, Suspense, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
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
import {
  KB_TEMPLATES_KEY,
  kbErrorText,
  loadKbTemplateContent,
  useKbTemplates,
  type KbTemplate,
} from "@/lib/kb/data";
import { copyKbFiles, kbTemplateFolder, pruneKbFolder } from "@/lib/kb/files";

const KbDocument = lazy(() =>
  import("@/components/kb/kb-document").then((m) => ({ default: m.KbDocument })),
);

/** Файлы, которые не удалось скопировать (нет доступа к исходной базе), — предупреждение. */
function warnFailedFiles(failed: number) {
  if (failed > 0)
    toast.warning(
      `Не удалось скопировать файлов: ${failed}. Они остались ссылками на исходную базу — у кого к ней нет доступа, их не увидит.`,
    );
}

/**
 * Текст шаблона в базу: файлы — копиями в папку шаблона (шаблоны общие для
 * всех баз, папку статьи читают только её читатели), лишние файлы папки —
 * прочь. Возвращает false, если не сохранилось.
 */
async function writeTemplateContent(id: string, content: unknown[]): Promise<boolean> {
  const folder = kbTemplateFolder(id);
  const copied = await copyKbFiles(content, folder);
  const { error } = await supabase
    .from("kb_templates")
    .update({ content: copied.content })
    .eq("id", id);
  if (error) {
    toast.error(kbErrorText(error.message));
    return false;
  }
  warnFailedFiles(copied.failed);
  await pruneKbFolder(folder, copied.content).catch(() => {});
  return true;
}

const NEW = "__new__";

/**
 * «Сохранить как шаблон» (№32): текст статьи (с неопубликованными правками,
 * если они есть) — новым шаблоном или поверх существующего. Шаблоны общие
 * для всех баз (решение владельца 2026-10-25); править шаблон можно и на
 * странице «Шаблоны» — KbTemplateEditor.
 */
export function KbSaveTemplateForm({
  content,
  defaultTitle,
  onDone,
}: {
  content: unknown[];
  defaultTitle: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { data: templates } = useKbTemplates();
  const [target, setTarget] = useState(NEW);
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const replacing = templates?.find((t) => t.id === target);

  const pickTarget = (value: string) => {
    setTarget(value);
    const t = templates?.find((x) => x.id === value);
    setTitle(t ? t.title : defaultTitle);
    setDescription(t ? t.description : "");
  };

  const save = async () => {
    const t = title.trim();
    if (!t) {
      toast.error("Укажите название шаблона");
      return;
    }
    setSaving(true);
    try {
      const row = { title: t, description: description.trim() };
      let id = replacing?.id;
      if (id) {
        const { error } = await supabase.from("kb_templates").update(row).eq("id", id);
        if (error) {
          toast.error(kbErrorText(error.message));
          return;
        }
      } else {
        const { data, error } = await supabase
          .from("kb_templates")
          .insert({ ...row, content })
          .select("id")
          .single();
        if (error) {
          toast.error(kbErrorText(error.message));
          return;
        }
        id = (data as { id: string }).id;
      }
      if (!(await writeTemplateContent(id, content))) return;
      await qc.invalidateQueries({ queryKey: [KB_TEMPLATES_KEY] });
      toast.success(replacing ? "Шаблон обновлён" : "Шаблон сохранён");
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Сохранить как шаблон</DialogTitle>
        <DialogDescription>
          Шаблон общий для всех баз знаний: новую статью в любой базе можно начать с этого текста —
          «Статья» → «Шаблон». Сама статья не меняется.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            {!!templates?.length && (
              <FormField
                label="Куда сохранить"
                tip="Новым шаблоном или поверх существующего — так шаблон обновляют."
              >
                <Select value={target} onValueChange={pickTarget}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEW}>Новый шаблон</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        Заменить «{t.title}»
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
            <FormField label="Название шаблона" required>
              <Input
                autoFocus
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
              />
            </FormField>
            <FormField label="Описание" tip="Когда брать этот шаблон — видно при создании статьи.">
              <Textarea
                value={description}
                maxLength={300}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
              />
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {replacing ? "Заменить" : "Сохранить"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

/**
 * Правка шаблона целиком (решение владельца 2026-10-25): название,
 * описание и текст в том же редакторе, что у статьи. Новые файлы — сразу в
 * папку шаблона. Сохраняется кнопкой; закрыть с правками — окно спросит
 * (`onDirtyChange` — родителю, он держит закрытие окна).
 */
export function KbTemplateEditor({
  baseId,
  template,
  onDirtyChange,
  onDone,
}: {
  /** База, из которой открыли: в ней ищутся сотрудники для «@». */
  baseId: string;
  template: KbTemplate;
  onDirtyChange: (dirty: boolean) => void;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const { data: initial, isLoading } = useQuery({
    queryKey: [KB_TEMPLATES_KEY, "content", template.id],
    queryFn: () => loadKbTemplateContent(template.id),
    // Правят свежий текст, а не закэшированный при просмотре.
    staleTime: 0,
    meta: { errorMessage: "Не удалось загрузить шаблон" },
  });
  const [title, setTitle] = useState(template.title);
  const [description, setDescription] = useState(template.description);
  // Текст — только если правили: onChange бывает и при открытии (BlockNote
  // дописывает id блоков), поэтому сравниваем с тем, каким открыли.
  const baseline = useRef("");
  const doc = useRef<unknown[] | null>(null);
  const [saving, setSaving] = useState(false);
  const touch = () => onDirtyChange(true);

  const save = async () => {
    const t = title.trim();
    if (!t) {
      toast.error("Укажите название шаблона");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from("kb_templates")
        .update({ title: t, description: description.trim() })
        .eq("id", template.id);
      if (error) {
        toast.error(kbErrorText(error.message));
        return;
      }
      if (doc.current && !(await writeTemplateContent(template.id, doc.current))) return;
      await qc.invalidateQueries({ queryKey: [KB_TEMPLATES_KEY] });
      toast.success("Шаблон сохранён");
      onDirtyChange(false);
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Шаблон</DialogTitle>
        <DialogDescription>
          Правки шаблона не меняют статьи, уже созданные по нему, — только новые.
        </DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Название" required>
                <Input
                  value={title}
                  maxLength={120}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    touch();
                  }}
                />
              </FormField>
              <FormField
                label="Описание"
                tip="Когда брать этот шаблон — видно при создании статьи."
              >
                <Input
                  value={description}
                  maxLength={300}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    touch();
                  }}
                />
              </FormField>
            </div>
            <div className="min-h-64 rounded-md border py-3">
              {isLoading || !initial ? (
                <div className="flex items-center gap-2 px-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> Загружаем шаблон…
                </div>
              ) : (
                <Suspense fallback={null}>
                  <KbDocument
                    baseId={baseId}
                    nodeId={template.id}
                    filesFolder={kbTemplateFolder(template.id)}
                    initial={initial}
                    editable
                    onReady={(ready) => {
                      baseline.current = JSON.stringify(ready);
                    }}
                    onChange={(next) => {
                      if (JSON.stringify(next) === baseline.current) return;
                      doc.current = next;
                      touch();
                    }}
                  />
                </Suspense>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving || isLoading}>
            {saving && <Loader2 className="animate-spin" />}
            Сохранить шаблон
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

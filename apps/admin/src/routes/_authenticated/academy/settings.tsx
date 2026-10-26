import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { PersonCell } from "@/components/academy/parts";
import { useConfirm } from "@/components/confirm-dialog";
import { DropIndicator } from "@/components/kb/drop-indicator";
import { AcademySettingsPageSkeleton } from "@/components/page-skeletons";
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
import { FormField, InfoNote } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { StatusChip } from "@/components/ui/status-chip";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { hasRight } from "@/lib/admin-access";
import { useDragRow, type RowDropOperation } from "@/hooks/use-drag-row";
import { supabase } from "@/integrations/supabase/client";
import {
  ACAD_KEY,
  acadCoursesQuery,
  acadFoldersQuery,
  acadStaffQuery,
  invalidateAcademy,
} from "@/lib/academy/data";
import { acadError, plural } from "@/lib/academy/logic";
import type { AcadFolder } from "@/lib/academy/types";
import { unwrap } from "@/lib/query";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/academy/settings")({
  head: () => ({ meta: [{ title: "Настройки — Академия — Lady Stretch" }] }),
  pendingComponent: AcademySettingsPageSkeleton,
  component: SettingsPage,
});

/**
 * Настройки «Академии» (право «Создаёт курсы»): папки каталога курсов и кто
 * ведёт обучение. Права («Создаёт курсы», «Проверяет ответы») выдаёт
 * владелец в «Доступах» — здесь только список.
 */
function SettingsPage() {
  return (
    <AdminShell title="Настройки Академии">
      <div className="mx-auto max-w-3xl space-y-6">
        <FoldersSection />
        <TeamSection />
      </div>
    </AdminShell>
  );
}

function FoldersSection() {
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: folders } = useQuery(acadFoldersQuery);
  const { data: courses } = useQuery(acadCoursesQuery);
  const [editing, setEditing] = useState<AcadFolder | "new" | null>(null);
  const list = folders ?? [];

  const remove = async (f: AcadFolder) => {
    const n = (courses ?? []).filter((c) => c.folder_id === f.id).length;
    const ok = await confirm({
      title: `Удалить папку «${f.title}»?`,
      description: n
        ? `${n} ${plural(n, ["курс", "курса", "курсов"])} останутся — «Без папки».`
        : "Курсов в ней нет.",
    });
    if (!ok) return;
    const { error } = await supabase.from("acad_folders").delete().eq("id", f.id);
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  const reorder = async (sourceId: string, targetId: string, op: RowDropOperation) => {
    const ids = list.map((f) => f.id).filter((id) => id !== sourceId);
    ids.splice(ids.indexOf(targetId) + (op === "reorder-after" ? 1 : 0), 0, sourceId);
    const { error } = await supabase.rpc("acad_reorder", { p_kind: "folders", p_ids: ids });
    if (error) toast.error(acadError(error));
    await invalidateAcademy(qc);
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Папки курсов</h2>
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus /> Папка
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Разделы каталога: «Администраторы», «Тренеры», «Руководители»… Порядок — перетаскиванием.
      </p>
      {list.length === 0 ? (
        <InfoNote variant="empty">Папок пока нет — все курсы «Без папки».</InfoNote>
      ) : (
        <ul className="divide-y rounded-lg border bg-background">
          {list.map((f) => (
            <FolderRow
              key={f.id}
              folder={f}
              courses={(courses ?? []).filter((c) => c.folder_id === f.id).length}
              onEdit={() => setEditing(f)}
              onDelete={() => void remove(f)}
              onDropRow={(sourceId, op) => void reorder(sourceId, f.id, op)}
            />
          ))}
        </ul>
      )}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          {editing && (
            <FolderForm
              key={editing === "new" ? "new" : editing.id}
              folder={editing === "new" ? null : editing}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </section>
  );
}

function FolderRow({
  folder,
  courses,
  onEdit,
  onDelete,
  onDropRow,
}: {
  folder: AcadFolder;
  courses: number;
  onEdit: () => void;
  onDelete: () => void;
  onDropRow: (sourceId: string, op: RowDropOperation) => void;
}) {
  const drag = useDragRow<HTMLLIElement, HTMLSpanElement>({
    id: folder.id,
    type: "acad-folder",
    onDrop: onDropRow,
  });
  return (
    <li
      ref={drag.ref}
      className={cn("relative flex items-center gap-2 px-2 py-1.5", drag.dragging && "opacity-40")}
    >
      <DropIndicator instruction={drag.instruction} />
      <span ref={drag.handleRef} className="cursor-grab text-muted-foreground" aria-hidden>
        <GripVertical className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{folder.title}</span>
        <span className="text-xs text-muted-foreground">
          {courses} {plural(courses, ["курс", "курса", "курсов"])}
        </span>
      </span>
      <Button variant="ghost" size="icon" aria-label="Переименовать" onClick={onEdit}>
        <Pencil />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Удалить папку" onClick={onDelete}>
        <Trash2 />
      </Button>
    </li>
  );
}

function FolderForm({ folder, onDone }: { folder: AcadFolder | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(folder?.title ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const t = title.trim();
    if (!t) {
      toast.error("Укажите название папки");
      return;
    }
    setSaving(true);
    try {
      const { error } = folder
        ? await supabase.from("acad_folders").update({ title: t }).eq("id", folder.id)
        : await supabase.from("acad_folders").insert({
            title: t,
            sort_order:
              (
                await unwrap<{ sort_order: number }[]>(
                  supabase.from("acad_folders").select("sort_order"),
                )
              ).reduce((m, f) => Math.max(m, f.sort_order), 0) + 1,
          });
      if (error) throw new Error(error.message);
      await qc.invalidateQueries({ queryKey: [ACAD_KEY] });
      onDone();
    } catch (e) {
      toast.error(acadError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{folder ? "Папка" : "Новая папка"}</DialogTitle>
        <DialogDescription>Раздел каталога курсов.</DialogDescription>
      </DialogHeader>
      <DialogForm onSubmit={save}>
        <DialogBody>
          <FormField label="Название" required>
            <Input
              autoFocus
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onDone} disabled={saving}>
            Отмена
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {folder ? "Сохранить" : "Создать"}
          </Button>
        </DialogFooter>
      </DialogForm>
    </>
  );
}

function TeamSection() {
  const access = useAdminAccess();
  const isAdmin = !!access?.academy?.is_admin;
  const canManage = hasRight(access, "roles.manage") || hasRight(access, "users.manage");
  const { data: staff } = useQuery(acadStaffQuery);
  const { data: rights } = useQuery({
    queryKey: [ACAD_KEY, "team"],
    queryFn: () =>
      unwrap<{ user_id: string; can_create: boolean; can_review: boolean }[]>(
        supabase.from("acad_staff").select("user_id, can_create, can_review"),
      ),
    enabled: isAdmin,
    meta: { errorMessage: "Не удалось загрузить права Академии" },
  });
  const people = (staff ?? []).flatMap((p) => {
    const r = rights?.find((x) => x.user_id === p.user_id);
    return r?.can_create || r?.can_review ? [{ person: p, r }] : [];
  });
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">Кто ведёт обучение</h2>
      <p className="text-sm text-muted-foreground">
        «Создаёт курсы» — конструктор, назначения, отчёт; «Проверяет ответы» — свободные ответы
        учеников. Администраторам Академии открыто всё. Права выдаются ролями в{" "}
        {canManage ? (
          <Link to="/access/roles" className="font-medium text-brand-on-light hover:underline">
            «Пользователях и ролях»
          </Link>
        ) : (
          "«Пользователях и ролях»"
        )}
        .
      </p>
      {isAdmin ? (
        <ul className="divide-y rounded-lg border bg-background">
          {people.map(({ person, r }) => (
            <li key={person.user_id} className="flex items-center gap-3 px-3 py-2">
              <PersonCell name={person.full_name} avatar={person.avatar_url} />
              <span className="ml-auto flex flex-wrap justify-end gap-1">
                {r?.can_create && <StatusChip tone="info">Создаёт курсы</StatusChip>}
                {r?.can_review && <StatusChip tone="info">Проверяет ответы</StatusChip>}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

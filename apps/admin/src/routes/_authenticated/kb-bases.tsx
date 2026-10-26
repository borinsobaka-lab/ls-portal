import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { AdminShell } from "@/components/admin-shell";
import { KbBaseForm } from "@/components/kb/base-dialog";
import { KbStorageCard } from "@/components/kb/storage-card";
import { DropIndicator } from "@/components/kb/drop-indicator";
import { KbBasesPageSkeleton } from "@/components/page-skeletons";
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { InfoNote } from "@/components/ui/form-field";
import { ListItemButton } from "@/components/ui/list-item-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAdminAccess } from "@/hooks/use-admin-access";
import { useDragRow, type RowDropOperation } from "@/hooks/use-drag-row";
import { supabase } from "@/integrations/supabase/client";
import { KB_BASES_KEY, kbBasesQuery } from "@/lib/kb/data";
import { kbIcon } from "@/lib/kb/icons";
import type { KbBase } from "@/lib/kb/types";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/kb-bases")({
  head: () => ({ meta: [{ title: "Базы знаний — Base40 Admin" }] }),
  pendingComponent: KbBasesPageSkeleton,
  component: KbBasesPage,
});

/**
 * «Управление» → «Знания» (только владельцу): все базы знаний. Владелец
 * заводит базы, меняет их порядок (перетаскиванием — так стоят вкладки в
 * шапке базы знаний) и настройки; доступы сотрудникам — в «Доступах».
 * Схема — db/migrations/2026-10-24_knowledge_base.sql.
 */
function KbBasesPage() {
  const access = useAdminAccess();
  const qc = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: allBases, isLoading, error } = useQuery(kbBasesQuery);
  const [editing, setEditing] = useState<KbBase | "new" | null>(null);

  const isOwner = !!access?.kbAdmin;
  const bases = allBases ?? [];

  const reorder = async (sourceId: string, targetId: string, op: RowDropOperation) => {
    const ids = bases.map((b) => b.id).filter((id) => id !== sourceId);
    const at = ids.indexOf(targetId) + (op === "reorder-after" ? 1 : 0);
    ids.splice(at, 0, sourceId);
    // Сразу на месте, база перепишет порядок одной командой.
    qc.setQueryData<KbBase[]>([KB_BASES_KEY], (prev) =>
      prev
        ? ids.flatMap((id, i) => {
            const b = prev.find((x) => x.id === id);
            return b ? [{ ...b, sort_order: i + 1 }] : [];
          })
        : prev,
    );
    const { error: err } = await supabase.rpc("kb_reorder_bases", { p_ids: ids });
    if (err) toast.error(`Не удалось сохранить порядок: ${err.message}`);
    await qc.invalidateQueries({ queryKey: [KB_BASES_KEY] });
  };

  const remove = async (base: KbBase) => {
    const ok = await confirm({
      title: `Удалить базу «${base.title}»?`,
      description:
        "Удалятся все её папки и статьи, история публикаций, отметки о прочтении и выданные доступы. Вернуть нельзя.",
    });
    if (!ok) return;
    const { error: err } = await supabase.from("kb_bases").delete().eq("id", base.id);
    if (err) {
      toast.error(`Не удалось удалить: ${err.message}`);
      return;
    }
    toast.success("База знаний удалена");
    await qc.invalidateQueries({ queryKey: [KB_BASES_KEY] });
  };

  return (
    <AdminShell
      title="Базы знаний"
      actions={
        isOwner ? (
          <Button onClick={() => setEditing("new")}>
            <Plus />
            Новая база
          </Button>
        ) : null
      }
    >
      <div className="mx-auto max-w-3xl space-y-3">
        {error && !allBases ? (
          <InfoNote variant="warning">{error.message}</InfoNote>
        ) : isLoading ? null : bases.length === 0 ? (
          <div className="rounded-lg border bg-background p-8 text-center text-sm text-muted-foreground">
            Баз знаний пока нет. Создайте первую — например, «Стандарты» или «Обучение партнёров».
          </div>
        ) : (
          <ul className="divide-y rounded-lg border bg-background">
            {bases.map((b) => (
              <BaseRow
                key={b.id}
                base={b}
                canManage={isOwner}
                onEdit={() => setEditing(b)}
                onDelete={() => remove(b)}
                onDropRow={(sourceId, op) => reorder(sourceId, b.id, op)}
              />
            ))}
          </ul>
        )}
        {isOwner && bases.length > 0 && (
          <p className="px-1 text-xs text-muted-foreground">
            Порядок — как у вкладок в шапке базы знаний: перетащите базу за ручку слева. Доступ
            сотрудникам — ролями в «Пользователях и ролях»: «Просмотр» или «Правка» базы.
          </p>
        )}
        {isOwner && <KbStorageCard />}
      </div>
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-lg">
          {editing && (
            <KbBaseForm
              key={editing === "new" ? "new" : editing.id}
              base={editing === "new" ? null : editing}
              onDone={() => setEditing(null)}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmDialog}
    </AdminShell>
  );
}

function BaseRow({
  base,
  canManage,
  onEdit,
  onDelete,
  onDropRow,
}: {
  base: KbBase;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onDropRow: (sourceId: string, op: RowDropOperation) => void;
}) {
  const Icon = kbIcon(base.icon);
  const drag = useDragRow<HTMLLIElement, HTMLSpanElement>({
    id: base.id,
    type: "kb-base",
    disabled: !canManage,
    onDrop: onDropRow,
  });
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <li
      ref={drag.ref}
      className={cn("relative flex items-center gap-1", drag.dragging && "opacity-40")}
    >
      <DropIndicator instruction={drag.instruction} />
      {canManage && (
        <span
          ref={drag.handleRef}
          className="flex cursor-grab items-center self-center pl-2 text-muted-foreground"
          aria-hidden
        >
          <GripVertical className="size-4" />
        </span>
      )}
      <Link
        to="/kb/$baseId"
        params={{ baseId: base.id }}
        draggable={false}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md p-3 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sidebar text-white">
          <Icon className="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{base.title}</span>
          {base.description && (
            <span className="line-clamp-2 text-sm text-muted-foreground">{base.description}</span>
          )}
        </span>
        {base.rail_title !== base.title && (
          <span className="hidden shrink-0 sm:flex">
            <Badge variant="secondary" title="Подпись вкладки">
              {base.rail_title}
            </Badge>
          </span>
        )}
      </Link>
      {canManage && (
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="mr-2 shrink-0"
              aria-label={`База «${base.title}»: действия`}
            >
              <Ellipsis />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-1">
            <ListItemButton
              onClick={() => {
                setMenuOpen(false);
                onEdit();
              }}
            >
              <Pencil className="text-muted-foreground" />
              Настройки базы
            </ListItemButton>
            <ListItemButton
              className="text-destructive hover:text-destructive"
              onClick={() => {
                setMenuOpen(false);
                onDelete();
              }}
            >
              <Trash2 />
              Удалить базу
            </ListItemButton>
          </PopoverContent>
        </Popover>
      )}
    </li>
  );
}

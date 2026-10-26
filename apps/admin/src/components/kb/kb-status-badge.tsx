import { StatusChip } from "@/components/ui/status-chip";
import { KB_STATUS_LABEL, type KbStatus } from "@/lib/kb/types";
import type { StatusTone } from "@/components/ui/status-chip-styles";

const TONE: Record<KbStatus, StatusTone> = {
  published: "positive",
  draft: "warning",
  archived: "neutral",
};

/** Статус статьи или папки базы знаний — его видит только редактор. */
export function KbStatusBadge({ status, size }: { status: KbStatus; size?: "sm" }) {
  return (
    <StatusChip tone={TONE[status]} size={size === "sm" ? "sm" : "default"}>
      {KB_STATUS_LABEL[status]}
    </StatusChip>
  );
}

/**
 * «Есть правки» — у опубликованной статьи копится черновик правок. Черновики
 * и правки — оранжевым (`warning`), опубликованное — зелёным (решение
 * владельца 2026-10-25: «ещё не готово» понятно любому, цвет базы не берём).
 */
export function KbDraftBadge({ size }: { size?: "sm" }) {
  return (
    <StatusChip tone="warning" size={size === "sm" ? "sm" : "default"}>
      Есть правки
    </StatusChip>
  );
}

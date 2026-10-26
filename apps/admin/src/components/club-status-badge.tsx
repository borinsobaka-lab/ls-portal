import { statusChipBase, statusChipSize } from "@/components/ui/status-chip-styles";
import { cn } from "@/lib/utils";
import { CLUB_STATUS_FULL, CLUB_STATUS_LABEL, type ClubStatus } from "@/lib/client-status";

const STYLES: Record<ClubStatus, string> = {
  chk: "bg-emerald-100 text-emerald-700 border-emerald-200",
  pchk: "bg-blue-100 text-blue-700 border-blue-200",
  bchk: "bg-orange-100 text-orange-700 border-orange-200",
};

export function ClubStatusBadge({
  status,
  className,
  withFull,
  size = "default",
}: {
  status: ClubStatus;
  className?: string;
  withFull?: boolean;
  /** sm — компактная плашка в строке клиента окна занятия (2026-10-13). */
  size?: "default" | "sm";
}) {
  return (
    <span
      title={CLUB_STATUS_FULL[status]}
      className={cn(statusChipBase, "border", statusChipSize[size], STYLES[status], className)}
    >
      {CLUB_STATUS_LABEL[status]}
      {withFull && <span className="font-normal opacity-80">· {CLUB_STATUS_FULL[status]}</span>}
    </span>
  );
}

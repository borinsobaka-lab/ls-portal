import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  ClipboardList,
  FileText,
  GraduationCap,
  Hourglass,
  Lock,
  XCircle,
} from "lucide-react";

import { StaffAvatar } from "@/components/employee-photo";
import { InfoNote } from "@/components/ui/form-field";
import { StatusChip } from "@/components/ui/status-chip";
import { resolveKbFileUrl } from "@/lib/kb/files";
import {
  ATTEMPT_LABEL,
  ATTEMPT_TONE,
  COURSE_STATUS_LABEL,
  COURSE_STATUS_TONE,
  PROGRESS_LABEL,
  PROGRESS_TONE,
} from "@/lib/academy/logic";
import type {
  AcadAttemptStatus,
  AcadCourseStatus,
  AcadProgressStatus,
  AcadStepKind,
  AcadStepState,
} from "@/lib/academy/types";
import { cn } from "@/lib/utils";

export function CourseStatusBadge({ status, size }: { status: AcadCourseStatus; size?: "sm" }) {
  return (
    <StatusChip tone={COURSE_STATUS_TONE[status]} size={size === "sm" ? "sm" : "default"}>
      {COURSE_STATUS_LABEL[status]}
    </StatusChip>
  );
}

/** Ход по курсу; просроченный непройденный — красным «Просрочен». */
export function ProgressBadge({
  status,
  overdue,
}: {
  status: AcadProgressStatus;
  overdue?: boolean;
}) {
  if (overdue && status !== "completed") return <StatusChip tone="negative">Просрочен</StatusChip>;
  return <StatusChip tone={PROGRESS_TONE[status]}>{PROGRESS_LABEL[status]}</StatusChip>;
}

export function AttemptBadge({ status }: { status: AcadAttemptStatus }) {
  return <StatusChip tone={ATTEMPT_TONE[status]}>{ATTEMPT_LABEL[status]}</StatusChip>;
}

/** Полоса прогресса: доля пройденных шагов. */
export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-all",
          value >= 100 ? "bg-emerald-500" : "bg-primary",
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

/** Обложка курса (файл в kb-media) или заглушка с шапочкой. */
export function CourseCover({ cover, className }: { cover: string | null; className?: string }) {
  const { data: src } = useQuery({
    queryKey: ["acad", "cover-url", cover],
    queryFn: () => resolveKbFileUrl(cover!),
    enabled: !!cover,
    staleTime: 50 * 60_000,
  });
  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-slate-800 to-slate-600 text-white/80",
        className,
      )}
    >
      {src ? (
        <img src={src} alt="" className="absolute inset-0 size-full object-cover" />
      ) : (
        <GraduationCap className="size-10" />
      )}
    </div>
  );
}

/** Значок шага: вид (урок/тест) или состояние у ученика. */
export function StepIcon({
  kind,
  state,
  locked,
  className,
}: {
  kind: AcadStepKind;
  state?: AcadStepState;
  locked?: boolean;
  className?: string;
}) {
  const cls = cn("size-4 shrink-0", className);
  if (locked) return <Lock className={cn(cls, "text-muted-foreground")} />;
  if (state === "done" || state === "passed")
    return <CheckCircle2 className={cn(cls, "text-emerald-600")} />;
  if (state === "review") return <Hourglass className={cn(cls, "text-amber-600")} />;
  if (state === "failed") return <XCircle className={cn(cls, "text-destructive")} />;
  if (state === "todo") return <Circle className={cn(cls, "text-muted-foreground")} />;
  return kind === "quiz" ? (
    <ClipboardList className={cn(cls, "text-muted-foreground")} />
  ) : (
    <FileText className={cn(cls, "text-muted-foreground")} />
  );
}

/** Сотрудник в строке: аватарка и имя. */
export function PersonCell({ name, avatar }: { name: string | null; avatar: string | null }) {
  const label = name || "Сотрудник";
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StaffAvatar value={avatar} name={label} className="size-7 text-xs" />
      <span className="truncate font-medium">{label}</span>
    </span>
  );
}

/** Пустой список: значок, заголовок, пояснение и действие. */
export function AcadEmpty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-background p-8 text-center">
      <GraduationCap className="mx-auto size-8 text-muted-foreground" />
      <p className="mt-3 font-medium">{title}</p>
      {children && (
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * У курса нет черновика правок (в отличие от базы знаний): правка
 * опубликованного урока или вопроса сразу у учеников — предупреждаем явно.
 */
export function PublishedNote() {
  return (
    <InfoNote variant="warning" className="flex items-start gap-2">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>
        Курс опубликован, а черновика правок у курса нет (не как в базе знаний): каждая правка
        сохраняется сама и сразу видна ученикам. Большую переделку лучше делать, сняв курс с
        публикации (меню «⋯» курса) — на это время ученики его не увидят.
      </span>
    </InfoNote>
  );
}

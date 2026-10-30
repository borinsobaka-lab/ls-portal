import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { InfoNote } from "@/components/ui/form-field";
import type { ActivitiesPayload } from "@/lib/analytics/onec-reports/payload";

/** Доска «Занятия» — перенос их activities.html. */
export function ActivitiesBoard({
  payload,
}: {
  payload: ActivitiesPayload;
  controls: OnecControls;
}) {
  return (
    <InfoNote>
      Доска «Занятия»: {payload.start} — {payload.end}.
    </InfoNote>
  );
}

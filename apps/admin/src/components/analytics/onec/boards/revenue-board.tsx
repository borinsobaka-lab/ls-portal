import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { InfoNote } from "@/components/ui/form-field";
import type { RevenuePayload } from "@/lib/analytics/onec-reports/payload";

/** Доска «Выручка» — перенос их revenue.html. */
export function RevenueBoard({ payload }: { payload: RevenuePayload; controls: OnecControls }) {
  return (
    <InfoNote>
      Доска «Выручка»: {payload.start} — {payload.end}.
    </InfoNote>
  );
}

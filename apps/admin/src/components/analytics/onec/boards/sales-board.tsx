import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { InfoNote } from "@/components/ui/form-field";
import type { SalesPayload } from "@/lib/analytics/onec-reports/payload";

/** Доска «Продажи абонементов» — перенос их sales.html. */
export function SalesBoard({ payload }: { payload: SalesPayload; controls: OnecControls }) {
  return (
    <InfoNote>
      Доска «Продажи абонементов»: {payload.start} — {payload.end}.
    </InfoNote>
  );
}

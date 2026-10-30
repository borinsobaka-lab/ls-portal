import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { InfoNote } from "@/components/ui/form-field";
import type { FunnelPayload } from "@/lib/analytics/onec-reports/payload";

/** Доска «Воронка пробных» — перенос их funnel.html. */
export function FunnelBoard({ payload }: { payload: FunnelPayload; controls: OnecControls }) {
  return (
    <InfoNote>
      Доска «Воронка пробных»: {payload.start} — {payload.end}.
    </InfoNote>
  );
}

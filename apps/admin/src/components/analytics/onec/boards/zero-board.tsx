import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { InfoNote } from "@/components/ui/form-field";
import type { ZeroPayload } from "@/lib/analytics/onec-reports/payload";

/** Доска «Нулевая номенклатура» — перенос их zero.html. */
export function ZeroBoard({ payload }: { payload: ZeroPayload; controls: OnecControls }) {
  return (
    <InfoNote>
      Доска «Нулевая номенклатура»: {payload.start} — {payload.end}.
    </InfoNote>
  );
}

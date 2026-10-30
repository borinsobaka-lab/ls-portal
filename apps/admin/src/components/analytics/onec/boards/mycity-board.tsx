import type { OnecControls } from "@/components/analytics/onec/report-frame";
import { InfoNote } from "@/components/ui/form-field";
import type { PartnerPayload } from "@/lib/analytics/onec-reports/payload";

/** Доска «Мой город» — перенос их partner.html. */
export function PartnerBoard({ payload }: { payload: PartnerPayload; controls: OnecControls }) {
  return (
    <InfoNote>
      Доска «Мой город»: {payload.start} — {payload.end}.
    </InfoNote>
  );
}

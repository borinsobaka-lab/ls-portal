import { ADMIN_VERSION } from "@/lib/app-version";

/**
 * Версия админки в самом низу рейки — под «Выходом» (RailAccount) и в
 * скелетоне каркаса. Номер — lib/app-version.ts.
 */
export function RailVersion() {
  return (
    <span
      className="pb-1 text-[11px] leading-none text-white/55 tabular-nums"
      title={`Версия админки ${ADMIN_VERSION}`}
    >
      v{ADMIN_VERSION}
    </span>
  );
}

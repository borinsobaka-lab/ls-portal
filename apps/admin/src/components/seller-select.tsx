import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StudioStaffRow } from "@/lib/studio-staff";
import { StaffOption } from "@/components/employee-photo";

/** Выбор администратора, который продал (список и правила — lib/studio-staff.ts). */
export function SellerSelect({
  admins,
  loading,
  value,
  onChange,
}: {
  admins: StudioStaffRow[];
  loading: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={loading || admins.length === 0}>
      <SelectTrigger>
        <SelectValue
          placeholder={
            loading
              ? "Загрузка…"
              : admins.length === 0
                ? "Нет администраторов"
                : "Выберите администратора"
          }
        />
      </SelectTrigger>
      <SelectContent>
        {admins.map((a) => (
          <SelectItem key={a.id} value={a.id} textValue={a.full_name}>
            <StaffOption name={a.full_name} photo={a.photo_url} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

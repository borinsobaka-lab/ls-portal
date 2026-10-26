import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useConfirm } from "@/components/confirm-dialog";
import { RailVersion } from "@/components/rail-version";
import { supabase } from "@/integrations/supabase/client";
import { useStaffProfile } from "@/hooks/use-staff-profile";
import { initials } from "@/lib/format";
import { useStorageUrl } from "@/lib/storage";

/**
 * Последний пункт рейки, под «Клубами»: аватарка сотрудника и «Выход» под ней — по
 * аватарке видно, кто вошёл, имя — во всплывающей подсказке и в
 * подтверждении. Аватарку ставит владелец в «Доступах». Ниже — версия
 * админки (RailVersion).
 */
export function RailAccount() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const { data: profile } = useStaffProfile();
  const src = useStorageUrl("avatars", profile?.avatarUrl);
  const name = profile?.displayName ?? "";

  const handleSignOut = async () => {
    const ok = await confirm({
      title: "Выйти из админки?",
      description: name
        ? `${name}: чтобы войти снова, понадобится код из письма.`
        : "Чтобы войти снова, понадобится код из письма.",
      confirmLabel: "Выйти",
      destructive: false,
    });
    if (!ok) return;
    // scope local: учётная запись у сотрудника-клиента общая с клиентским
    // приложением, глобальный выход (по умолчанию) выкинул бы и оттуда.
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) {
      toast.error(error.message);
      return;
    }
    // Кэш запросов — данные прошлого сотрудника; следующему он не нужен.
    queryClient.clear();
    toast.success("Вы вышли из аккаунта");
    navigate({ to: "/auth" });
  };

  return (
    <>
      <button
        type="button"
        onClick={handleSignOut}
        title={name ? `${name} — выйти` : "Выйти"}
        aria-label={name ? `Выйти (${name})` : "Выйти"}
        className="group/rail flex w-full flex-col items-center gap-1 rounded-lg py-2 outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      >
        <Avatar className="size-8 ring-2 ring-white/20 transition group-hover/rail:ring-white/50">
          {src && <AvatarImage src={src} alt={name} className="object-cover" />}
          <AvatarFallback className="bg-white/15 text-[11px] font-semibold text-white">
            {initials(name, "?")}
          </AvatarFallback>
        </Avatar>
        <span className="text-[11px] leading-tight font-medium text-white/70 group-hover/rail:text-white">
          Выход
        </span>
      </button>
      <RailVersion />
      {confirmDialog}
    </>
  );
}

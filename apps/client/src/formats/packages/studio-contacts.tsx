import { useT } from "@/i18n";

/**
 * Связь со студией на экране входа (пакетное приложение, решение владельца
 * 2026-10-12): если почта не найдена среди клиентов — под сообщением кнопки
 * Instagram, Facebook Messenger и WhatsApp. Ссылки — из переменных сборки
 * (VITE_STUDIO_*_URL); при входе студия клиента ещё неизвестна, поэтому
 * не из «Контактов и правил». Пустая переменная — кнопки нет.
 */
/** WhatsApp студии — и «Поддержка» в профиле (решение владельца 2026-10-14). */
export const STUDIO_WHATSAPP_URL: string = import.meta.env.VITE_STUDIO_WHATSAPP_URL ?? "";
const WHATSAPP_URL = STUDIO_WHATSAPP_URL;

const CONTACTS = [
  {
    label: "Instagram",
    href: import.meta.env.VITE_STUDIO_INSTAGRAM_URL ?? "",
    Icon: InstagramIcon,
  },
  { label: "Facebook", href: import.meta.env.VITE_STUDIO_MESSENGER_URL ?? "", Icon: MessengerIcon },
  { label: "WhatsApp", href: WHATSAPP_URL, Icon: WhatsAppIcon },
].filter((c) => c.href);

/** Чат WhatsApp студии (тот же номер, что на экране входа) с готовым текстом. */
export function studioWhatsAppLink(text: string) {
  return `${WHATSAPP_URL}?text=${encodeURIComponent(text)}`;
}

export function StudioContactButtons() {
  const t = useT();
  return (
    <div className="space-y-2 pt-1">
      <p className="text-center text-sm text-muted-foreground">
        {t("Напишите нам — поможем войти")}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {CONTACTS.map(({ label, href, Icon }) => (
          <a
            key={label}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-16 flex-col items-center justify-center gap-1 rounded-xl border border-border bg-card text-xs font-semibold text-foreground transition active:scale-[0.97]"
          >
            <Icon className="h-6 w-6 text-primary" />
            {label}
          </a>
        ))}
      </div>
    </div>
  );
}

// Иконки — контурные, в стиле Tabler (brand-instagram / -messenger / -whatsapp).
function IconBase({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <IconBase className={className}>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <circle cx="12" cy="12" r="3" />
      <path d="M16.5 7.5v.01" />
    </IconBase>
  );
}

function MessengerIcon({ className }: { className?: string }) {
  return (
    <IconBase className={className}>
      <path d="M3 20l1.3-3.9a9 8 0 1 1 3.4 2.9L3 20" />
      <path d="M8 13l3-2 2 2 3-2" />
    </IconBase>
  );
}

export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <IconBase className={className}>
      <path d="M3 21l1.65-3.8a9 9 0 1 1 3.4 2.9L3 21" />
      <path d="M9 10a.5.5 0 0 0 1 0V9a.5.5 0 0 0-1 0v1a5 5 0 0 0 5 5h1a.5.5 0 0 0 0-1h-1a.5.5 0 0 0 0 1" />
    </IconBase>
  );
}

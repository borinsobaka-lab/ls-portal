import { Link, useRouterState } from "@tanstack/react-router";
import {
  Home,
  DumbbellLargeMinimalistic,
  User,
  MenuDots,
  Card,
  UsersGroupRounded,
  MapPointFavourite,
} from "@solar-icons/react";
import { useEffect, useRef, useState } from "react";
import { resetPageScrollPosition } from "@/lib/page-scroll";
import { IS_PACKAGES } from "@/lib/terms";
import { msg, useT } from "@/i18n";

type NavItem = {
  to: "/" | "/schedule" | "/club" | "/memberships";
  label: string;
  Icon: typeof Home;
  exact: boolean;
};

const mainItems: NavItem[] = [
  { to: "/", label: msg("Главное"), Icon: Home, exact: true },
  { to: "/schedule", label: msg("Бронь"), Icon: DumbbellLargeMinimalistic, exact: false },
  { to: "/club", label: msg("Клуб"), Icon: UsersGroupRounded, exact: false },
];

const moreItems = [
  { to: "/profile" as const, label: msg("Профиль"), Icon: User },
  { to: "/memberships" as const, label: msg("Абонементы"), Icon: Card },
];

// Пакетное приложение (решение владельца 2026-10-11): «Расписание» вместо
// «Брони», «Студия» вместо «Клуба», «Абонементы» — на месте «Ещё», «Профиль»
// — правой плиткой вместо ассистента (W).
const packagesItems: NavItem[] = [
  { to: "/", label: msg("Главное"), Icon: Home, exact: true },
  { to: "/schedule", label: msg("Расписание"), Icon: DumbbellLargeMinimalistic, exact: false },
  { to: "/club", label: msg("Студия"), Icon: MapPointFavourite, exact: false },
  { to: "/memberships", label: msg("Абонементы"), Icon: Card, exact: false },
];

export function BottomNav() {
  return IS_PACKAGES ? <PackagesBottomNav /> : <SubscriptionBottomNav />;
}

function PackagesBottomNav() {
  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center">
      <div className="pointer-events-auto w-full max-w-md px-3 pb-3">
        {/* items-stretch: плитка «Профиль» той же высоты, что плашка разделов,
            и с тем же скруглением. */}
        <div className="relative flex items-stretch gap-2">
          <div className="glass-dark relative flex-1 rounded-[26px] px-1.5 py-1.5">
            <ul className="grid grid-cols-4">
              {packagesItems.map(({ to, label, Icon, exact }) => (
                <li key={to}>
                  <Link
                    to={to}
                    activeOptions={{ exact }}
                    onPointerDown={resetPageScrollPosition}
                    onClick={resetPageScrollPosition}
                    className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl active:bg-white/5"
                  >
                    {({ isActive }) => <NavItemBody Icon={Icon} label={label} active={isActive} />}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <Link
            to="/profile"
            onPointerDown={resetPageScrollPosition}
            onClick={resetPageScrollPosition}
            className="glass-dark flex w-[72px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-[26px] active:bg-white/5"
          >
            {({ isActive }) => <NavItemBody Icon={User} label={msg("Профиль")} active={isActive} />}
          </Link>
        </div>
        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </nav>
  );
}

/**
 * Иконка и подпись раздела. Активный — белая иконка на «пилюле» основного
 * цвета и белая подпись: розовый текст на тёмном стекле читался плохо
 * (решение владельца 2026-10-11).
 */
function NavItemBody({
  Icon,
  label,
  active,
}: {
  Icon: typeof Home;
  label: string;
  active: boolean;
}) {
  const t = useT();
  return (
    <>
      <span
        className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors duration-200 ${
          active ? "bg-primary text-primary-foreground" : "text-white/70"
        }`}
      >
        <Icon className="h-[22px] w-[22px]" weight="BoldDuotone" />
      </span>
      <span
        className={`text-[11px] transition-colors duration-200 ${
          active ? "font-semibold text-white" : "font-medium text-white/70"
        }`}
      >
        {t(label)}
      </span>
    </>
  );
}

function SubscriptionBottomNav() {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLLIElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const moreActive = moreItems.some((i) => pathname.startsWith(i.to));

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (
        moreRef.current &&
        !moreRef.current.contains(target) &&
        menuRef.current &&
        !menuRef.current.contains(target)
      ) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [moreOpen]);

  return (
    <nav className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center">
      <div className="pointer-events-auto w-full max-w-md px-3 pb-3">
        <div className="relative flex items-end gap-2">
          {/* Main glass tile with 4 sections */}
          <div className="glass-dark relative flex-1 rounded-3xl px-1.5 py-1.5">
            <ul className="grid grid-cols-4">
              {mainItems.map(({ to, label, Icon, exact }) => (
                <li key={to}>
                  <Link
                    to={to}
                    activeOptions={{ exact }}
                    onPointerDown={resetPageScrollPosition}
                    onClick={resetPageScrollPosition}
                    activeProps={{ className: "text-primary" }}
                    inactiveProps={{ className: "text-white/70" }}
                    className="flex h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium transition-colors active:bg-white/5"
                  >
                    <Icon className="h-6 w-6" weight="BoldDuotone" />
                    <span>{t(label)}</span>
                  </Link>
                </li>
              ))}

              <li ref={moreRef} className="relative">
                <button
                  type="button"
                  onClick={() => setMoreOpen((v) => !v)}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  className={`flex h-14 w-full flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium transition-colors active:bg-white/5 ${
                    moreActive || moreOpen ? "text-primary" : "text-white/70"
                  }`}
                >
                  <MenuDots className="h-6 w-6" weight="BoldDuotone" />
                  <span>{t("Ещё")}</span>
                </button>
              </li>
            </ul>
          </div>

          {moreOpen && (
            <div
              ref={menuRef}
              role="menu"
              className="glass-dark absolute bottom-full right-[calc(0.5rem+68px)] mb-2 w-52 origin-bottom-right rounded-3xl p-1.5 animate-in fade-in zoom-in-95"
            >
              {moreItems.map(({ to, label, Icon }) => {
                const active = pathname.startsWith(to);
                return (
                  <Link
                    key={to}
                    to={to}
                    role="menuitem"
                    onPointerDown={resetPageScrollPosition}
                    onClick={resetPageScrollPosition}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors active:bg-white/10 ${
                      active ? "text-primary" : "text-white/90"
                    }`}
                  >
                    <Icon className="h-6 w-6" weight="BoldDuotone" />
                    <span>{t(label)}</span>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Assistant tile (disabled) */}
          <button
            type="button"
            disabled
            aria-label={t("Ассистент (скоро)")}
            title={t("Скоро")}
            className="assistant-glow glass-dark flex h-[68px] w-[68px] shrink-0 items-center justify-center rounded-3xl text-white/70 cursor-not-allowed"
          >
            <span className="glow-orb" />
            <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-[15px] font-black leading-none">
              W
            </span>
          </button>
        </div>
        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </nav>
  );
}

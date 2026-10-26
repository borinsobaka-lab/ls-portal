import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown } from "@solar-icons/react";

import instagramLogo from "@/assets/instagram-logo.webp";
import packagesLogo from "@/assets/packages-logo.svg";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT, type Translator } from "@/i18n";
import { mediaUrl } from "@/lib/media";
import {
  ABOUT_CHAPTERS,
  ABOUT_COMMUNITY,
  ABOUT_INSTAGRAM,
  ABOUT_INTRO,
  ABOUT_PLACEHOLDER_PHOTO,
  ABOUT_THANKS,
  type AboutChapter,
} from "./about-config";
import { aboutQuery, type AboutSettings } from "./queries";

/**
 * «О нас» — вкладка «Студии» пакетного приложения (решение владельца
 * 2026-10-12, заменила «О студии»): одна прокручиваемая история Lady Stretch.
 * Обложка → хронология (первая студия, вторая, «сегодня» с цифрами) →
 * Instagram → благодарность. Блоки разделены, как на главной: серые
 * промежутки между скруглёнными белыми секциями.
 *
 * Тексты и даты — about-config.ts; фото, цифры, подписчики и сетка
 * Instagram — из админки (aboutQuery). Нет своего фото — временное
 * ABOUT_PLACEHOLDER_PHOTO; нет числа — показатель скрыт; нет фото Instagram —
 * плашка профиля без сетки (выдуманных постов не показываем).
 */
export function AboutTab() {
  const { data, isPending } = useQuery(aboutQuery());
  // Пока ответа нет (и нет сохранённого кэша) — серые плашки вместо фото,
  // чтобы временное фото не мелькало перед настоящим. Ошибка (в том числе
  // таблицы ещё нет — миграция не выкачена) — как пустые настройки:
  // временные фото, без цифр и сетки Instagram.
  const settings: AboutSettings | null | undefined = isPending ? undefined : (data ?? null);

  return (
    <div className="bg-muted">
      {/* Отступ под табами — белый, внутри секции: серая полоска над обложкой лишняя. */}
      <section className="rounded-b-[14px] bg-background px-4 pt-4 pb-8">
        <Intro settings={settings} />
      </section>

      <div className="h-3" />

      <section className="rounded-[14px] bg-background pt-8 pb-2">
        <ol>
          {ABOUT_CHAPTERS.map((chapter) => (
            <TimelineItem key={chapter.photosKey} date={chapter.date}>
              <Chapter chapter={chapter} settings={settings} />
            </TimelineItem>
          ))}
          <TimelineItem date={ABOUT_COMMUNITY.date} last>
            <Community settings={settings} />
          </TimelineItem>
        </ol>
      </section>

      <div className="h-3" />

      <section className="rounded-[14px] bg-background px-4 py-8">
        <Instagram settings={settings} />
      </section>

      <div className="h-3" />

      <section className="rounded-t-[14px] bg-background px-6 pt-12 pb-4 text-center">
        <Thanks />
      </section>
    </div>
  );
}

// ---- Блоки ------------------------------------------------------------------

function Intro({ settings }: { settings: AboutSettings | null | undefined }) {
  const t = useT();
  return (
    <>
      <Reveal>
        {/* Обложка горизонтальная 16:9 (решение владельца 2026-10-12):
            поверх — только логотип, заголовок — под фото (на низкой
            картинке он закрывал бы кадр, по-грузински — в три строки). */}
        <div className="relative aspect-video w-full overflow-hidden rounded-3xl bg-muted">
          <Photo
            src={photoSrc(settings, settings?.cover_photo_path)}
            className="absolute inset-0 h-full w-full"
            eager
          />
          <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/45 to-transparent" />
          <img
            src={packagesLogo}
            alt="Lady Stretch"
            className="absolute left-4 top-4 h-7 w-auto"
            decoding="async"
          />
        </div>
        <h2 className="mt-5 text-[26px] font-semibold leading-tight">{t(ABOUT_INTRO.title)}</h2>
      </Reveal>
      <Reveal className="mt-4">
        <Paragraphs items={ABOUT_INTRO.paragraphs} />
      </Reveal>
      <Reveal className="mt-6 flex items-center gap-1.5 text-sm font-semibold text-primary">
        {t("Наша история")}
        <ArrowDown className="h-4 w-4" weight="Linear" />
      </Reveal>
    </>
  );
}

/**
 * Точка хронологии: дата и содержимое справа от тонкой линии. Линия идёт от
 * точки вниз до следующей; у последней («Сегодня») — заканчивается на ней.
 */
function TimelineItem({
  date,
  last = false,
  children,
}: {
  date: string;
  last?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <li className="relative pr-4 pb-10 pl-11">
      {!last && (
        <span className="absolute top-3 bottom-0 left-[23px] w-px bg-primary/25" aria-hidden />
      )}
      <span
        className={`absolute top-[5px] rounded-full bg-primary ring-4 ring-primary/15 ${
          last ? "left-[17px] h-[13px] w-[13px]" : "left-[18px] h-[11px] w-[11px]"
        }`}
        aria-hidden
      />
      <Reveal>
        <div className="text-sm font-semibold text-primary">{t(date)}</div>
      </Reveal>
      {children}
    </li>
  );
}

function Chapter({
  chapter,
  settings,
}: {
  chapter: AboutChapter;
  settings: AboutSettings | null | undefined;
}) {
  const t = useT();
  const caption = t(chapter.galleryCaption);
  return (
    <>
      <Reveal>
        <h2 className="mt-1 text-2xl font-semibold">{t(chapter.title)}</h2>
        <Paragraphs items={chapter.paragraphs} className="mt-3" />
      </Reveal>
      <Reveal className="mt-6">
        <div className="mb-3 text-sm font-medium text-muted-foreground">{caption}</div>
        <Gallery photos={galleryPhotos(settings, chapter.photosKey)} label={caption} />
      </Reveal>
    </>
  );
}

/**
 * Широкие плитки («18 специалистов», «с 2023»): текст сразу за цифрой, без
 * общей колонки цифр — с ней текст «специалистов» стоял далеко от «18»
 * (решение владельца 2026-10-13).
 */
const WIDE_TILE = "col-span-2 flex items-center gap-3";

function Community({ settings }: { settings: AboutSettings | null | undefined }) {
  const t = useT();
  const c = ABOUT_COMMUNITY;
  // Плитки 2 в ряд: студии, цифры и команда из админки (без числа — плитки
  // нет), «с 2023 года» — во всю ширину последней строкой. Цифры «набегают» от
  // нуля, когда плитки доезжают до экрана (CountUp).
  const team = settings?.[c.specialists.key];
  const tiles = [
    { value: c.studios.count, plus: false, label: t(c.studios.label) },
    ...c.counts.flatMap((k) => {
      const n = settings?.[k.key];
      return n && n > 0 ? [{ value: n, plus: true, label: t(k.label) }] : [];
    }),
    ...(team && team > 0
      ? [{ value: team, plus: false, label: c.specialists.label(t, team) }]
      : []),
  ];
  // «с 2023» / «since 2023» / «2023 წლიდან»: год крупно, слова вокруг — мельче.
  const [sinceBefore, sinceAfter = ""] = t(c.since.template)
    .split("{year}")
    .map((x) => x.trim());
  return (
    <>
      <Reveal>
        <h2 className="mt-1 text-2xl font-semibold">{t(c.title)}</h2>
        <Paragraphs items={c.paragraphs} className="mt-3" />
      </Reveal>
      {/* Плитки — на всю ширину секции, без отступа под хронологию. */}
      <Reveal className="mt-6 -ml-7">
        <dl className="grid grid-cols-2 gap-2">
          {tiles.map((tile, i) => {
            // Непарная последняя плитка — во всю ширину, как «с 2023»: цифра
            // слева, текст справа (решение владельца 2026-10-12).
            const wide = tiles.length % 2 === 1 && i === tiles.length - 1;
            return (
              <div
                key={tile.label}
                className={`rounded-2xl bg-primary/[0.06] p-4 ${wide ? WIDE_TILE : ""}`}
              >
                <dt className="shrink-0 text-[28px] leading-none font-bold whitespace-nowrap text-primary tabular-nums">
                  <CountUp value={tile.value} plus={tile.plus} />
                </dt>
                <dd className={`text-[13px] leading-snug text-foreground/80 ${wide ? "" : "mt-2"}`}>
                  {tile.label}
                </dd>
              </div>
            );
          })}
          <div className={`${WIDE_TILE} rounded-2xl bg-primary/[0.06] p-4`}>
            <dt className="shrink-0 whitespace-nowrap text-primary">
              {sinceBefore && <span className="mr-1 text-lg font-semibold">{sinceBefore}</span>}
              <span className="text-[28px] leading-none font-bold tabular-nums">
                {c.since.year}
              </span>
              {sinceAfter && <span className="ml-1 text-lg font-semibold">{sinceAfter}</span>}
            </dt>
            <dd className="text-[13px] leading-snug text-foreground/80">{t(c.since.label)}</dd>
          </div>
        </dl>
      </Reveal>
      {/* Широкое фото — на всю ширину секции, из-под отступа хронологии
          (линия у последней точки уже закончилась). */}
      <Reveal className="mt-6 -ml-7">
        <div className="relative aspect-[16/10] w-full overflow-hidden rounded-2xl bg-muted">
          <Photo
            src={photoSrc(settings, settings?.community_photo_path)}
            className="absolute inset-0 h-full w-full"
          />
        </div>
      </Reveal>
    </>
  );
}

function Instagram({ settings }: { settings: AboutSettings | null | undefined }) {
  const t = useT();
  const ig = ABOUT_INSTAGRAM;
  const followers = settings?.instagram_followers;
  const posts = (settings?.instagram_posts ?? [])
    .map((p) => ({ src: mediaUrl(p.path, "studio-photos"), url: p.url?.trim() || ig.url }))
    .filter((p): p is { src: string; url: string } => !!p.src)
    .slice(0, 6);
  // Все загруженные фото (до шести), даже неполным рядом: раньше сетка
  // показывала только полные ряды, и из пяти фото два пропадали.
  const grid = posts;

  return (
    <>
      <Reveal>
        <h2 className="text-2xl font-semibold">{t(ig.title)}</h2>
        <Paragraphs items={ig.paragraphs} className="mt-3" />
      </Reveal>
      <Reveal className="mt-6">
        <div className="rounded-3xl bg-gradient-to-br from-primary/[0.12] to-primary/[0.04] p-4">
          <a
            href={ig.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-3"
          >
            <img src={instagramLogo} alt="" className="h-12 w-12 shrink-0" decoding="async" />
            <span className="min-w-0">
              <span className="block text-xs text-muted-foreground">{t(ig.label)}</span>
              <span className="block truncate font-semibold">{ig.handle}</span>
              {followers && followers > 0 && (
                <span className="block text-xs text-muted-foreground">
                  {t.plural(followers, "{count} подписчик|{count} подписчика|{count} подписчиков", {
                    count: plusCount(t, followers),
                  })}
                </span>
              )}
            </span>
          </a>
          {grid.length > 0 ? (
            <div className="mt-4 grid grid-cols-3 gap-1.5">
              {grid.map((p, i) => (
                <a
                  key={i}
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("Публикация Instagram {n}", { n: i + 1 })}
                  className="relative aspect-square overflow-hidden rounded-xl bg-muted transition-transform active:scale-[0.97]"
                >
                  <Photo src={p.src} className="absolute inset-0 h-full w-full" />
                </a>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-sm leading-relaxed text-foreground/80">{t(ig.fallbackText)}</p>
          )}
          <Button asChild className="mt-4 w-full">
            <a href={ig.url} target="_blank" rel="noopener noreferrer">
              {t(ig.button)}
            </a>
          </Button>
        </div>
      </Reveal>
    </>
  );
}

function Thanks() {
  const t = useT();
  return (
    <Reveal>
      <h2 className="text-2xl font-semibold">{t(ABOUT_THANKS.title)}</h2>
      <Paragraphs
        items={ABOUT_THANKS.paragraphs}
        className="mx-auto mt-4 max-w-sm text-muted-foreground"
      />
      {/* Подпись — логотип серым (сам файл белый, для тёмных фонов). */}
      <span
        role="img"
        aria-label="Lady Stretch"
        className="mx-auto mt-10 block aspect-[1064/305] h-7 bg-muted-foreground/70"
        style={{
          maskImage: `url(${packagesLogo})`,
          WebkitMaskImage: `url(${packagesLogo})`,
          maskSize: "contain",
          WebkitMaskSize: "contain",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          maskPosition: "center",
          WebkitMaskPosition: "center",
        }}
      />
    </Reveal>
  );
}

// ---- Галерея ------------------------------------------------------------------

/**
 * Фото студии листаются пальцем (нативная горизонтальная прокрутка с
 * прилипанием — вертикальному скроллу страницы не мешает), без автолистания.
 * Справа выглядывает следующее фото; под галереей — точки.
 */
function Gallery({ photos, label }: { photos: (string | null)[]; label: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const frame = useRef<number | null>(null);

  const onScroll = () => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      const el = scrollRef.current;
      const first = el?.querySelector<HTMLElement>("[data-slide]");
      if (!el || !first) return;
      const step = first.offsetWidth + 12; // gap-3
      // У правого края последнее фото может не дойти до начала — считаем его активным.
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
      setActive(atEnd ? photos.length - 1 : Math.round(el.scrollLeft / step));
    });
  };
  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  return (
    <div>
      {/* -mr-4: галерея доходит до правого края экрана. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="no-scrollbar -mr-4 flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain pr-4"
        aria-label={label}
      >
        {photos.map((src, i) => (
          <div
            key={i}
            data-slide
            className="relative aspect-[4/5] w-[80%] max-w-[320px] shrink-0 snap-start overflow-hidden rounded-2xl bg-muted"
          >
            <Photo src={src} className="absolute inset-0 h-full w-full" />
          </div>
        ))}
      </div>
      {photos.length > 1 && (
        <div className="mt-3 flex gap-1.5" aria-hidden>
          {photos.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === active ? "w-4 bg-primary" : "w-1.5 bg-primary/25"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Мелочи -------------------------------------------------------------------

/** 3500 → «3 500+» / «3,500+» — разделители разрядов языка. */
function plusCount(t: Translator, n: number): string {
  return `${t.number(n)}+`;
}

/** Фото из админки; нет своего — временное; данных ещё нет (undefined) — null. */
function photoSrc(
  settings: AboutSettings | null | undefined,
  path: string | null | undefined,
): string | null {
  if (settings === undefined) return null;
  return mediaUrl(path, "studio-photos") ?? ABOUT_PLACEHOLDER_PHOTO;
}

/** Галерея главы: свои фото или три временных. */
function galleryPhotos(
  settings: AboutSettings | null | undefined,
  key: AboutChapter["photosKey"],
): (string | null)[] {
  if (settings === undefined) return [null, null, null];
  const own = (settings?.[key] ?? [])
    .map((p) => mediaUrl(p, "studio-photos"))
    .filter((u): u is string => !!u);
  return own.length > 0 ? own : Array(3).fill(ABOUT_PLACEHOLDER_PHOTO);
}

/** Картинка, плавно проявляющаяся после загрузки; src null — серая плашка. */
function Photo({
  src,
  className = "",
  eager = false,
}: {
  src: string | null;
  className?: string;
  eager?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  if (!src) return <Skeleton className={`rounded-none ${className}`} />;
  return (
    <img
      src={src}
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onLoad={() => setLoaded(true)}
      // Картинка из кэша браузера бывает готова раньше onLoad.
      ref={(img) => {
        if (img?.complete && img.naturalWidth > 0 && !loaded) setLoaded(true);
      }}
      className={`object-cover transition-opacity duration-500 ${
        loaded ? "opacity-100" : "opacity-0"
      } ${className}`}
    />
  );
}

function Paragraphs({ items, className = "" }: { items: string[]; className?: string }) {
  const t = useT();
  return (
    <div className={`space-y-3 text-[15px] leading-relaxed text-foreground/80 ${className}`}>
      {items.map((text) => (
        <p key={text}>{t(text)}</p>
      ))}
    </div>
  );
}

/**
 * Лёгкое появление при прокрутке: блок всплывает на несколько пикселей и
 * проявляется, один раз. Только opacity и transform — без filter (см.
 * CLAUDE.md, «Плавная прокрутка»). При «уменьшить движение» — сразу на месте.
 */
function Reveal({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useInView(ref);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-700 ease-out motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none ${
        shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  );
}

/** Элемент доехал до экрана (один раз; без IntersectionObserver — сразу). */
function useInView(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/**
 * Число «набегает» от нуля до значения, когда доезжает до экрана (~1,6 с,
 * замедляясь к концу). Ширину держит невидимое итоговое число под
 * набегающим: текст рядом с цифрой не ездит. При «уменьшить движение» —
 * сразу итог.
 */
function CountUp({ value, plus }: { value: number; plus: boolean }) {
  const t = useT();
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref);
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(value);
      return;
    }
    const duration = 1600;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(value * eased));
      if (p < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [inView, value]);

  return (
    <span ref={ref} className="inline-grid">
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {t.number(value)}
        {plus && "+"}
      </span>
      <span className="col-start-1 row-start-1">
        {t.number(shown)}
        {plus && "+"}
      </span>
    </span>
  );
}

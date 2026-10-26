/**
 * Общий каталог клубов (db/migrations/2026-10-13_zzzz_packages_shared_catalog.sql):
 * тренировки и номенклатура клубов с пакетами тренировок — один список на все
 * пакетные клубы (решение владельца 2026-10-13), у подписочного клуба — свой.
 * Строка по-прежнему с studio_id клуба, где её завели, поэтому список
 * грузится по клубам каталога: `.in("studio_id", catalogStudioIds(...))`.
 * Модуль без React: его читает и сервер (инструменты Kate).
 */
import type { StudioFormat } from "@/lib/studio-formats";

/** Форматы, у которых каталог общий для всех клубов формата. */
export const SHARED_CATALOG_FORMATS: readonly StudioFormat[] = ["packages"];

export type CatalogStudio = {
  id: string;
  format: StudioFormat;
  /** Название — где нужно показать клуб сети (фильтр «Клуб» в «Абонементах»). */
  name?: string;
};

/**
 * Клубы, чьи тренировки и номенклатура видны в клубе studioId: все клубы
 * того же формата, если каталог формата общий, иначе только он сам.
 */
export function catalogStudioIds(studios: CatalogStudio[], studioId: string): string[] {
  const own = studios.find((s) => s.id === studioId);
  if (!own || !SHARED_CATALOG_FORMATS.includes(own.format)) return [studioId];
  return studios.filter((s) => s.format === own.format).map((s) => s.id);
}

/** Общий ли каталог у клуба этого формата (подсказки «правка — во всех клубах»). */
export const isSharedCatalog = (format: StudioFormat | undefined | null) =>
  !!format && SHARED_CATALOG_FORMATS.includes(format);

/**
 * Клубы общей базы клиентов клуба studioId
 * (db/migrations/2026-10-17_packages_shared_clients.sql, решение владельца
 * 2026-10-17): у пакетного — все пакетные клубы (одна карточка клиента на
 * сеть, её видят и ведут сотрудники любого пакетного клуба), у подписочного —
 * он сам. Это те же клубы, что у общего каталога (сеть в базе —
 * studios_same_network). Списки и поиск клиентов — `.in("studio_id", …)`;
 * продажа — по-прежнему в активном клубе.
 */
export function networkStudioIds(studios: CatalogStudio[], studioId: string): string[] {
  return catalogStudioIds(studios, studioId);
}

/** Клубы a и b — одна база клиентов (тот же клуб или оба пакетные). */
export function sameNetwork(studios: CatalogStudio[], a: string, b: string): boolean {
  return a === b || networkStudioIds(studios, a).includes(b);
}

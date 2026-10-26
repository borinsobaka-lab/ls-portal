import { describe, expect, test } from "bun:test";

import {
  catalogStudioIds,
  isSharedCatalog,
  networkStudioIds,
  sameNetwork,
  type CatalogStudio,
} from "./studio-catalog";

const studios: CatalogStudio[] = [
  { id: "vake", format: "packages" },
  { id: "base40", format: "subscription" },
  { id: "saburtalo", format: "packages" },
  { id: "other-sub", format: "subscription" },
];

describe("catalogStudioIds", () => {
  test("пакетный клуб — каталог всех пакетных клубов", () => {
    expect(catalogStudioIds(studios, "vake")).toEqual(["vake", "saburtalo"]);
    expect(catalogStudioIds(studios, "saburtalo")).toEqual(["vake", "saburtalo"]);
  });

  test("подписочный клуб — только свой каталог", () => {
    expect(catalogStudioIds(studios, "base40")).toEqual(["base40"]);
  });

  test("клуб не найден в списке — только он сам", () => {
    expect(catalogStudioIds(studios, "new")).toEqual(["new"]);
    expect(catalogStudioIds([], "vake")).toEqual(["vake"]);
  });

  test("isSharedCatalog", () => {
    expect(isSharedCatalog("packages")).toBe(true);
    expect(isSharedCatalog("subscription")).toBe(false);
    expect(isSharedCatalog(undefined)).toBe(false);
  });
});

describe("networkStudioIds / sameNetwork", () => {
  test("пакетные клубы — одна база клиентов", () => {
    expect(networkStudioIds(studios, "vake")).toEqual(["vake", "saburtalo"]);
    expect(sameNetwork(studios, "vake", "saburtalo")).toBe(true);
    expect(sameNetwork(studios, "saburtalo", "vake")).toBe(true);
  });

  test("подписочный клуб — своя база, с пакетными и другими подписочными не общая", () => {
    expect(networkStudioIds(studios, "base40")).toEqual(["base40"]);
    expect(sameNetwork(studios, "base40", "base40")).toBe(true);
    expect(sameNetwork(studios, "base40", "other-sub")).toBe(false);
    expect(sameNetwork(studios, "base40", "vake")).toBe(false);
    expect(sameNetwork(studios, "vake", "base40")).toBe(false);
  });

  test("клуб не найден — только он сам", () => {
    expect(networkStudioIds(studios, "new")).toEqual(["new"]);
    expect(sameNetwork(studios, "new", "vake")).toBe(false);
    expect(sameNetwork([], "vake", "vake")).toBe(true);
  });
});

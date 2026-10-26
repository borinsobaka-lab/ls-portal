import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";

import { LOCALE_COOKIE, parseLocale, readDocumentLocale } from "./locales";

/** Язык из cookie: на сервере — из запроса, в браузере — из document.cookie. */
export const getRequestLocale = createIsomorphicFn()
  .server(() => parseLocale(getCookie(LOCALE_COOKIE)))
  .client(() => readDocumentLocale());

/**
 * Словарь: грузинский. Ключ — русский текст из кода (t("…"), msg("…")),
 * значение — перевод. Разделы — по экранам; одинаковый ключ в двух разделах
 * должен переводиться одинаково (побеждает раздел ниже по списку).
 * Проверка полноты — `bun run i18n:check` (из apps/client).
 */
import type { Dictionary } from "../types";
import common from "./common";
import auth from "./auth";
import app from "./app";
import home from "./home";
import profile from "./profile";
import stats from "./stats";
import workout from "./workout";
import schedule from "./schedule";
import memberships from "./memberships";
import packages from "./packages";
import about from "./about";
import onboarding from "./onboarding";
import invite from "./invite";
import notifications from "./notifications";
import install from "./install";
import feedback from "./feedback";
import nps from "./nps";

const dict: Dictionary = {
  ...common,
  ...auth,
  ...app,
  ...home,
  ...profile,
  ...stats,
  ...workout,
  ...schedule,
  ...memberships,
  ...packages,
  ...about,
  ...onboarding,
  ...invite,
  ...notifications,
  ...install,
  ...feedback,
  ...nps,
};

export default dict;

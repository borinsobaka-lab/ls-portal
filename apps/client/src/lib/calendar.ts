import { APP_BRAND, APP_FORMAT, FORMAT_APP_URL } from "@/lib/app-format";

const UID_HOST = new URL(FORMAT_APP_URL[APP_FORMAT]).host;

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function toICSDate(iso: string) {
  const d = new Date(iso);
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function escapeICS(s: string) {
  // \r\n и одиночный \r тоже: описания из админки приходят с CRLF, а
  // «голый» \r внутри значения ломает разбор строки календарём.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export type CalendarEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  description?: string | null;
  location?: string | null;
};

export function googleCalendarUrl(e: CalendarEvent) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${toICSDate(e.startsAt)}/${toICSDate(e.endsAt)}`,
  });
  if (e.description) params.set("details", e.description);
  if (e.location) params.set("location", e.location);
  return `https://www.google.com/calendar/render?${params.toString()}`;
}

export function outlookLiveUrl(e: CalendarEvent) {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: e.title,
    startdt: new Date(e.startsAt).toISOString(),
    enddt: new Date(e.endsAt).toISOString(),
  });
  if (e.description) params.set("body", e.description);
  if (e.location) params.set("location", e.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function office365Url(e: CalendarEvent) {
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    subject: e.title,
    startdt: new Date(e.startsAt).toISOString(),
    enddt: new Date(e.endsAt).toISOString(),
  });
  if (e.description) params.set("body", e.description);
  if (e.location) params.set("location", e.location);
  return `https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`;
}

export function yahooCalendarUrl(e: CalendarEvent) {
  const params = new URLSearchParams({
    v: "60",
    title: e.title,
    st: toICSDate(e.startsAt),
    et: toICSDate(e.endsAt),
  });
  if (e.description) params.set("desc", e.description);
  if (e.location) params.set("in_loc", e.location);
  return `https://calendar.yahoo.com/?${params.toString()}`;
}

export function buildICS(e: CalendarEvent) {
  const now = toICSDate(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${APP_BRAND}//RU`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.id}@${UID_HOST}`,
    `DTSTAMP:${now}`,
    `DTSTART:${toICSDate(e.startsAt)}`,
    `DTEND:${toICSDate(e.endsAt)}`,
    `SUMMARY:${escapeICS(e.title)}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${escapeICS(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeICS(e.location)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadICS(e: CalendarEvent) {
  const ics = buildICS(e);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${e.title.replace(/[^\p{L}\p{N}_-]+/gu, "_") || "event"}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

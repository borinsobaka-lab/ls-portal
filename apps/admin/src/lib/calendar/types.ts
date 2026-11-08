/**
 * Календарь портала — типы ответов RPC `cal_*`
 * (db/migrations/2026-11-08_zzzzzzzzzzz_calendar.sql).
 */
export type CalColor =
  | "blue"
  | "sky"
  | "teal"
  | "green"
  | "lime"
  | "amber"
  | "orange"
  | "red"
  | "pink"
  | "purple"
  | "violet"
  | "gray";

export type CalLevel = "view" | "edit" | "manage";

export type Calendar = {
  id: string;
  kind: "personal" | "shared";
  name: string;
  color: CalColor;
  description: string | null;
  owner_id: string | null;
  level: CalLevel;
};

export type CalAccessRow = {
  subject: "all" | "unit" | "user" | "project";
  unit_id?: string | null;
  unit_scope?: "all" | "heads";
  with_subunits?: boolean;
  user_id?: string | null;
  project_id?: string | null;
  level: CalLevel;
};

export type CalendarFull = Calendar & { access: CalAccessRow[] | null };

export type CalSourceOptions = {
  company: boolean;
  units: string[];
  projects: { id: string; title: string; color: string | null }[];
};

export type RRuleFreq = "daily" | "workdays" | "weekly" | "monthly" | "yearly";
export type RRule = {
  freq: RRuleFreq;
  interval?: number;
  /** 1 — понедельник … 7 — воскресенье. */
  weekdays?: number[];
  /** Последний день повторов, «2026-12-31». */
  until?: string;
};

export type Response = "pending" | "accepted" | "declined" | "maybe";

/** Повторение события в сетке (cal_events_range). */
export type CalOccurrence = {
  id: string;
  occ: string;
  start: string;
  end: string;
  all_day: boolean;
  day_from: string;
  day_to: string;
  title: string;
  location: string | null;
  calendar_id: string;
  color: CalColor;
  recurring: boolean;
  video: boolean;
  my_response: Response | null;
  attendees: number;
  can_edit: boolean;
  organizer_id: string | null;
};

export type CalEvent = {
  id: string;
  calendar: { id: string; name: string; color: CalColor; kind: Calendar["kind"]; visible: boolean };
  title: string;
  description: string | null;
  location: string | null;
  all_day: boolean;
  tz: string;
  starts_at: string;
  ends_at: string;
  occ_start: string;
  occ_end: string;
  day_from: string;
  day_to: string;
  rrule: RRule | null;
  series_id: string | null;
  original_start: string | null;
  video: boolean;
  reminders: number[];
  my_reminders: number[] | null;
  my_response: Response | null;
  organizer_id: string | null;
  attendees: { user_id: string; response: Response }[];
  can_edit: boolean;
  chat_id: string | null;
  created_at: string;
};

export type CalInvite = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  tz: string;
  recurring: boolean;
  rrule: RRule | null;
  organizer_id: string | null;
};

export type CalOverlays = {
  tasks: { number: number; title: string; deadline: string; status: string; urgent: boolean }[];
  birthdays: { user_id: string; day: string }[];
  absences: { user_id: string; kind: string; starts_on: string; ends_on: string }[];
};

/** Слои поверх событий — включаются в меню. */
export type CalLayer = "tasks" | "birthdays" | "absences";

export type CalView = "timeGridDay" | "timeGridWeek" | "dayGridMonth" | "listWeek";

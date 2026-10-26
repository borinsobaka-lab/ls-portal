/**
 * Статусы посещений. Канон — booked | waitlist | attended | no_show | cancelled
 * (db/booking_hygiene.sql); completed/rejected — старые значения, которые
 * ещё встречаются в истории.
 */
export type BookingStatus =
  | "booked"
  | "waitlist"
  | "attended"
  | "no_show"
  | "cancelled"
  | "rejected"
  | "completed";

export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  booked: "Забронировано",
  waitlist: "Лист ожидания",
  attended: "Посещено",
  no_show: "Пропущено",
  cancelled: "Отменено",
  rejected: "Отклонена",
  completed: "Проведено",
};

/** Статусы для фильтра — только канонические. */
export const BOOKING_STATUS_FILTER: BookingStatus[] = [
  "booked",
  "waitlist",
  "attended",
  "no_show",
  "cancelled",
];

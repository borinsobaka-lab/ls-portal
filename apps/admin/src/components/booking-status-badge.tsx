import { StatusChip, type StatusTone } from "@/components/ui/status-chip";
import { BOOKING_STATUS_LABEL, type BookingStatus } from "@/lib/bookings";

function toneOf(status: BookingStatus): StatusTone {
  switch (status) {
    case "attended":
    case "completed":
      return "positive";
    case "cancelled":
      return "negative";
    case "rejected":
      return "warning";
    case "no_show":
      return "neutral";
    default:
      // booked, waitlist
      return "info";
  }
}

export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  return <StatusChip tone={toneOf(status)}>{BOOKING_STATUS_LABEL[status] ?? status}</StatusChip>;
}

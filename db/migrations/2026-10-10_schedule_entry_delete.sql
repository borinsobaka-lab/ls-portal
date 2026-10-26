-- ============================================================================
-- Удаление занятия -> записи клиентов в журнале «Отменено».
--
-- Было: брони (schedule_bookings) удаляются каскадом вместе с занятием, а
-- строки журнала bookings_log остаются «Забронировано» (booking_id просто
-- обнуляется). Потом mark_no_show_bookings превращала их в «Пропущено» —
-- клиентам ставились пропуски за занятия, которые отменила студия.
--
-- 1) Триггер после удаления занятия переводит его записи в журнале в
--    «Отменено» с причиной и сроком отмены.
-- 2) Разовое исправление уже испорченных строк.
--
-- Идемпотентно. Выполняет мигратор при старте админки (scripts/migrate.ts);
-- без DATABASE_URL — вручную в Supabase SQL Editor (Studio).
-- ============================================================================

-- Колонки причины/срока отмены (добавляет и booking_hygiene.sql — здесь на
-- случай, если он ещё не прогнан).
alter table public.bookings_log
  add column if not exists cancel_reason text,
  add column if not exists cancelled_lead_minutes int;

-- 1) Триггер ------------------------------------------------------------------
create or replace function public.bookings_log_cancel_on_entry_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bookings_log
     set status                 = 'cancelled',
         cancelled_at           = coalesce(cancelled_at, now()),
         cancel_reason          = coalesce(cancel_reason, 'Занятие отменено студией'),
         -- >0 — за сколько минут до начала отменено (как у отмены клиентом).
         cancelled_lead_minutes = coalesce(
           cancelled_lead_minutes,
           floor(extract(epoch from (starts_at - now())) / 60)::int
         ),
         updated_at             = now(),
         -- Брони к этому моменту уже удалены каскадом, а обнуление ссылки
         -- (on delete set null) ещё не применено: без явного null update
         -- падает на внешнем ключе и вместе с ним — удаление занятия.
         booking_id             = null
   where entry_id = old.id
     and status in ('booked', 'waitlist');
  return old;
end;
$$;

drop trigger if exists schedule_entries_cancel_log_ad on public.schedule_entries;
create trigger schedule_entries_cancel_log_ad
  after delete on public.schedule_entries
  for each row execute function public.bookings_log_cancel_on_entry_delete();

-- 2) Исправление истории --------------------------------------------------------
-- Строки журнала, чьё занятие уже удалено:
--  - «Забронировано» / «Лист ожидания» — занятие удалили, запись повисла;
--  - «Пропущено» с completed_at — ложный пропуск. Настоящий пропуск журнал
--    получает через бронь (триггер bookings_log_sync, completed_at не ставит);
--    completed_at ставит только прямой update в mark_no_show_bookings, а он
--    достаёт лишь строки без брони — то есть строки удалённых занятий.
-- Время удаления неизвестно, поэтому cancelled_at не выдумываем.
do $$
declare
  n int;
begin
  update public.bookings_log bl
     set status        = 'cancelled',
         cancel_reason = coalesce(bl.cancel_reason, 'Занятие удалено (исправлено задним числом)'),
         completed_at  = null,
         updated_at    = now()
   where bl.entry_id is not null
     and not exists (select 1 from public.schedule_entries se where se.id = bl.entry_id)
     and (
       bl.status in ('booked', 'waitlist')
       or (bl.status = 'no_show' and bl.completed_at is not null)
     );
  get diagnostics n = row_count;
  raise notice 'bookings_log: исправлено строк удалённых занятий: %', n;
end;
$$;

notify pgrst, 'reload schema';

-- ============================================================================
-- Триггерные уведомления (раздел «Мобильное приложение» → «Триггеры»):
-- автоматические пуши клиентам по событиям — напоминание о занятии, отмена,
-- замена тренера, абонемент заканчивается, платёж по рассрочке и т. д.
--
-- Уходят через ту же рассылку, что и пуши из админки
-- (2026-10-15_push_delivery.sql): каждое срабатывание — строка
-- push_notifications с trigger_key (в списке «Пуш-уведомлений» её нет), один
-- получатель (push_recipients) и доставки на его телефоны (push_deliveries) —
-- дальше их отправляет сервер админки. Пуш приходит на языке приложения на
-- телефоне, у кого уведомления выключены — видит его в ленте «Уведомления».
--
-- 1) push_triggers — настройки: строка на приложение (формат клубов) и
--    триггер: включён ли, тексты (русский в title/message, en/ka — в
--    translations, как у контента), ссылка перехода, параметры (за сколько
--    часов/дней, во сколько слать). Правка — раздел рейки «Мобильное
--    приложение» + клуб этого формата; строки заводит только миграция.
--    Переменные текста — {name}, {class}, {when}… (список у каждого
--    триггера — apps/admin/src/lib/push-triggers.ts).
-- 2) push_trigger_log — что уже отправлено (триггер × учётная запись ×
--    событие): повторный проход не шлёт второй раз.
-- 3) push_triggers_run() — проход по включённым триггерам; вызывает сервер
--    админки раз в минуту (lib/push/push-worker.server.ts), только
--    service_role. События берутся только с момента включения триггера
--    (active_since) — включение не рассылает старое. Ночью (22:00–09:00 по
--    Тбилиси) не шлются «необязательные» (оценка, пробное, остаток), утром
--    уходят; ежедневные — в свой час (send_hour).
-- 4) schedule_bookings.booked_by / booked_at — кто и когда записал
--    (триггер «Вас записали»: запись сделал не сам клиент).
-- 5) push_trigger_stats — сколько отправлено и прочитано за период (по
--    своим клубам, RLS push_notifications).
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Кто и когда записал --------------------------------------------------------

alter table public.schedule_bookings
  add column if not exists booked_by uuid,
  add column if not exists booked_at timestamptz;

comment on column public.schedule_bookings.booked_by is
  'Кто перевёл запись в «Записан» (auth.uid(): клиент сам или сотрудник). Пусто — до 2026-10-15 или сервер.';

-- Без security definer: auth.uid() — того, кто записывает (и внутри
-- book_schedule_entry / admin_book_client).
create or replace function public.schedule_bookings_booked_by()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'booked' and (tg_op = 'INSERT' or old.status is distinct from 'booked') then
    new.booked_by := auth.uid();
    new.booked_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_bookings_booked_by_biu on public.schedule_bookings;
create trigger schedule_bookings_booked_by_biu
  before insert or update of status on public.schedule_bookings
  for each row execute function public.schedule_bookings_booked_by();

-- 2. Настройки триггеров ----------------------------------------------------------

create table if not exists public.push_triggers (
  format text not null check (format in ('subscription', 'packages')),
  key text not null,
  enabled boolean not null default true,
  title text not null check (btrim(title) <> ''),
  message text,
  translations jsonb not null default '{}'::jsonb,
  action_url text,
  params jsonb not null default '{}'::jsonb,
  -- События раньше этого момента триггер не рассылает (ставится при включении).
  active_since timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (format, key)
);

comment on table public.push_triggers is
  'Триггерные уведомления клиентского приложения: строка на формат и триггер (2026-10-15_push_triggers.sql).';

alter table public.push_triggers enable row level security;
revoke all on public.push_triggers from public, anon, authenticated;
grant select on public.push_triggers to authenticated;
grant update (enabled, title, message, translations, action_url, params) on public.push_triggers to authenticated;
grant all on public.push_triggers to service_role;

drop policy if exists "push_triggers app select" on public.push_triggers;
create policy "push_triggers app select" on public.push_triggers
  for select to authenticated
  using (
    public.has_admin_section(auth.uid(), 'app')
    and exists (
      select 1 from public.studios s
       where s.format = push_triggers.format and public.is_trainer(auth.uid(), s.id)
    )
  );

drop policy if exists "push_triggers app update" on public.push_triggers;
create policy "push_triggers app update" on public.push_triggers
  for update to authenticated
  using (
    public.has_admin_section(auth.uid(), 'app')
    and exists (
      select 1 from public.studios s
       where s.format = push_triggers.format and public.is_trainer(auth.uid(), s.id)
    )
  )
  with check (public.has_admin_section(auth.uid(), 'app'));

-- Правка из админки: параметры — только известные и в своих пределах,
-- включение — с этого момента (старые события не рассылаются).
create or replace function public.push_triggers_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  r record;
  v_int integer;
  v_ok boolean;
begin
  for r in select key, value from jsonb_each(coalesce(new.params, '{}'::jsonb)) loop
    if jsonb_typeof(r.value) <> 'number' then
      raise exception 'Параметр % — число', r.key using errcode = '22023';
    end if;
    v_int := (r.value #>> '{}')::numeric::integer;
    -- CASE — отдельным присваиванием: в условии IF его THEN путает разбор.
    v_ok := (r.value #>> '{}')::numeric = v_int
      and case r.key
            when 'hours' then v_int between 1 and 72
            when 'days' then v_int between 0 and 90
            when 'left' then v_int between 1 and 10
            when 'send_hour' then v_int between 8 and 21
            else false
          end;
    if not v_ok then
      raise exception 'Недопустимое значение параметра %: %', r.key, r.value using errcode = '22023';
    end if;
  end loop;

  if new.translations is null or jsonb_typeof(new.translations) <> 'object' then
    new.translations := '{}'::jsonb;
  end if;
  new.title := btrim(new.title);
  new.message := nullif(btrim(coalesce(new.message, '')), '');
  new.action_url := nullif(btrim(coalesce(new.action_url, '')), '');

  if new.enabled and not old.enabled then
    new.active_since := now();
  end if;
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;

drop trigger if exists push_triggers_guard on public.push_triggers;
create trigger push_triggers_guard
  before update on public.push_triggers
  for each row execute function public.push_triggers_guard();

-- Стартовые тексты на трёх языках. Строки только добавляются: уже
-- отредактированные не перезаписываются.
insert into public.push_triggers (format, key, title, message, translations, action_url, params)
select f.format, t.key, t.title, t.message, t.translations::jsonb, t.action_url, t.params::jsonb
  from (values ('subscription'), ('packages')) as f(format)
  join (values
    ('class_reminder', null,
     'Скоро тренировка',
     '{name}, ждём вас на «{class}» {when}. Если планы изменились — отмените запись в приложении.',
     '{"en": {"title": "Your class is coming up", "message": "{name}, see you at {class} {when}. If your plans have changed, cancel your booking in the app."},
       "ka": {"title": "ვარჯიში მალე დაიწყება", "message": "{name}, გელოდებით „{class}“ ვარჯიშზე {when}. თუ გეგმები შეგეცვალათ, გააუქმეთ ჩაწერა აპლიკაციაში."}}',
     '/', '{"hours": 3}'),
    ('booked_for_client', null,
     'Вы записаны на тренировку',
     '{name}, вы записаны на «{class}» {when}. Ждём вас!',
     '{"en": {"title": "You''re booked", "message": "{name}, you''re booked for {class} {when}. See you there!"},
       "ka": {"title": "თქვენ ჩაწერილი ხართ", "message": "{name}, თქვენ ჩაწერილი ხართ „{class}“ ვარჯიშზე {when}. გელოდებით!"}}',
     '/', '{}'),
    ('class_cancelled', null,
     'Тренировка отменена',
     '{name}, к сожалению, «{class}» {when} отменена. Выберите другое время в расписании.',
     '{"en": {"title": "Class cancelled", "message": "{name}, unfortunately {class} {when} has been cancelled. Please choose another time in the schedule."},
       "ka": {"title": "ვარჯიში გაუქმდა", "message": "{name}, სამწუხაროდ, „{class}“ ვარჯიში {when} გაუქმდა. აირჩიეთ სხვა დრო განრიგში."}}',
     '/schedule', '{}'),
    ('trainer_substitution', null,
     'Замена тренера',
     '{name}, на «{class}» {when} вас встретит {trainer}.',
     '{"en": {"title": "Trainer change", "message": "{name}, {trainer} will lead {class} {when}."},
       "ka": {"title": "მწვრთნელის შეცვლა", "message": "{name}, „{class}“ ვარჯიშს {when} ჩაატარებს {trainer}."}}',
     '/', '{}'),
    ('membership_activated', null,
     'Абонемент оформлен',
     '{name}, абонемент «{membership}» оформлен. До встречи на тренировке!',
     '{"en": {"title": "Membership activated", "message": "{name}, your {membership} membership is all set. See you in class!"},
       "ka": {"title": "აბონემენტი გაფორმებულია", "message": "{name}, აბონემენტი „{membership}“ გაფორმებულია. შეხვედრამდე ვარჯიშზე!"}}',
     '/memberships', '{}'),
    ('membership_expiring', null,
     'Абонемент скоро закончится',
     '{name}, абонемент «{membership}» действует до {date}. Продлите его заранее, чтобы не прерывать тренировки.',
     '{"en": {"title": "Your membership ends soon", "message": "{name}, your {membership} membership is valid until {date}. Renew it in advance to keep training without a break."},
       "ka": {"title": "აბონემენტი მალე იწურება", "message": "{name}, აბონემენტი „{membership}“ მოქმედებს {date}-მდე. განაახლეთ წინასწარ, რომ ვარჯიში არ შეწყვიტოთ."}}',
     '/memberships', '{"days": 3, "send_hour": 11}'),
    ('membership_ended', null,
     'Абонемент закончился',
     '{name}, срок абонемента «{membership}» закончился. Продлите его, чтобы продолжить тренировки.',
     '{"en": {"title": "Your membership has ended", "message": "{name}, your {membership} membership has expired. Renew it to continue training."},
       "ka": {"title": "აბონემენტის ვადა ამოიწურა", "message": "{name}, აბონემენტის „{membership}“ ვადა ამოიწურა. განაახლეთ, რომ ვარჯიში გააგრძელოთ."}}',
     '/memberships', '{"send_hour": 11}'),
    ('visits_low', 'packages',
     'Осталось мало тренировок',
     '{name}, в абонементе «{membership}» осталось тренировок: {left}. Продлите заранее, чтобы не прерывать занятия.',
     '{"en": {"title": "Only a few classes left", "message": "{name}, classes left on your {membership} membership: {left}. Renew in advance to keep training without a break."},
       "ka": {"title": "ცოტა ვარჯიში დარჩა", "message": "{name}, აბონემენტში „{membership}“ დარჩენილი ვარჯიშები: {left}. განაახლეთ წინასწარ, რომ ვარჯიში არ შეწყვიტოთ."}}',
     '/memberships', '{"left": 2}'),
    ('visits_exhausted', 'packages',
     'Тренировки закончились',
     '{name}, в абонементе «{membership}» не осталось тренировок. Продлите его, чтобы записываться дальше.',
     '{"en": {"title": "No classes left", "message": "{name}, there are no classes left on your {membership} membership. Renew it to keep booking."},
       "ka": {"title": "ვარჯიშები ამოიწურა", "message": "{name}, აბონემენტში „{membership}“ ვარჯიშები აღარ დარჩა. განაახლეთ, რომ ჩაწერა გააგრძელოთ."}}',
     '/memberships', '{}'),
    ('trial_followup', 'packages',
     'Как вам пробная тренировка?',
     '{name}, спасибо, что пришли! Выберите абонемент в приложении, чтобы продолжить занятия.',
     '{"en": {"title": "How was your trial class?", "message": "{name}, thank you for coming! Choose a membership in the app to keep training."},
       "ka": {"title": "როგორ მოგეწონათ საცდელი ვარჯიში?", "message": "{name}, მადლობა, რომ მობრძანდით! აირჩიეთ აბონემენტი აპლიკაციაში, რომ ვარჯიში გააგრძელოთ."}}',
     '/memberships', '{"hours": 3}'),
    ('rate_trainer', 'packages',
     'Оцените тренировку',
     '{name}, как прошла «{class}»? Оцените тренера — {trainer}. Это займёт пару секунд.',
     '{"en": {"title": "Rate your class", "message": "{name}, how was {class}? Rate your trainer, {trainer}. It only takes a second."},
       "ka": {"title": "შეაფასეთ ვარჯიში", "message": "{name}, როგორ ჩაიარა „{class}“ ვარჯიშმა? შეაფასეთ მწვრთნელი — {trainer}. ამას მხოლოდ რამდენიმე წამი დასჭირდება."}}',
     '/club', '{"hours": 2}'),
    ('installment_due', null,
     'Скоро платёж по абонементу',
     '{name}, {date} — очередной платёж {amount} ₾ за абонемент «{membership}».',
     '{"en": {"title": "Upcoming payment", "message": "{name}, your next payment of {amount} ₾ for the {membership} membership is due on {date}."},
       "ka": {"title": "მოახლოებული გადახდა", "message": "{name}, აბონემენტის „{membership}“ შემდეგი გადახდა: {amount} ₾. გადახდის თარიღი: {date}."}}',
     '/memberships', '{"days": 1, "send_hour": 11}'),
    ('installment_overdue', null,
     'Платёж просрочен',
     '{name}, платёж {amount} ₾ за абонемент «{membership}» нужно было внести {date}. Пожалуйста, оплатите его в клубе.',
     '{"en": {"title": "Payment overdue", "message": "{name}, the payment of {amount} ₾ for your {membership} membership was due on {date}. Please pay it at the studio."},
       "ka": {"title": "გადახდის ვადა გავიდა", "message": "{name}, აბონემენტის „{membership}“ გადახდა ({amount} ₾) უნდა განხორციელებულიყო {date}. გთხოვთ, გადაიხადოთ კლუბში."}}',
     '/memberships', '{"days": 1, "send_hour": 11}'),
    ('no_visits', null,
     'Мы скучаем',
     '{name}, давно не виделись! Последняя тренировка была {date}. Запишитесь на занятие — ждём вас!',
     '{"en": {"title": "We miss you", "message": "{name}, it''s been a while! Your last class was on {date}. Book a class — we''re waiting for you!"},
       "ka": {"title": "მოგვენატრეთ", "message": "{name}, დიდი ხანია არ გვინახავხართ! ბოლო ვარჯიში იყო {date}. ჩაეწერეთ ვარჯიშზე — გელოდებით!"}}',
     '/schedule', '{"days": 14, "send_hour": 12}'),
    ('birthday', null,
     'С днём рождения! 🎉',
     '{name}, поздравляем с днём рождения! Желаем сил, энергии и отличных тренировок. Команда {club}',
     '{"en": {"title": "Happy birthday! 🎉", "message": "{name}, happy birthday! Wishing you strength, energy and great workouts. Team {club}"},
       "ka": {"title": "გილოცავთ დაბადების დღეს! 🎉", "message": "{name}, გილოცავთ დაბადების დღეს! გისურვებთ ძალას, ენერგიას და შესანიშნავ ვარჯიშებს. {club}-ის გუნდი"}}',
     null, '{"send_hour": 10}')
  ) as t(key, only_format, title, message, translations, action_url, params)
    on t.only_format is null or t.only_format = f.format
on conflict (format, key) do nothing;

-- 3. Журнал отправленного и связь с рассылкой -------------------------------------

create table if not exists public.push_trigger_log (
  trigger_key text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Событие: занятие, абонемент, платёж, год дня рождения…
  ref text not null,
  notification_id uuid references public.push_notifications(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (trigger_key, user_id, ref)
);

create index if not exists push_trigger_log_created_idx on public.push_trigger_log(created_at);

alter table public.push_trigger_log enable row level security;
revoke all on public.push_trigger_log from public, anon, authenticated;
grant all on public.push_trigger_log to service_role;

alter table public.push_notifications add column if not exists trigger_key text;

comment on column public.push_notifications.trigger_key is
  'Триггерное уведомление (push_triggers.key); null — рассылка из админки.';

create index if not exists push_notifications_trigger_idx
  on public.push_notifications(trigger_key, created_at desc) where trigger_key is not null;

-- Защита рассылки (из 2026-10-15_push_delivery.sql) + trigger_key: из админки
-- не ставится и не меняется.
create or replace function public.push_notifications_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'scheduled') then
      raise exception 'Новое уведомление сохраняется черновиком или запланированным'
        using errcode = '22023';
    end if;
    new.trigger_key := null;
    new.sent_at := null;
    new.finished_at := null;
    new.recipients_count := 0;
    new.devices_count := 0;
    new.sent_count := 0;
    new.delivered_count := 0;
    new.read_count := 0;
    new.failed_count := 0;
  else
    new.trigger_key := old.trigger_key;
    new.sent_at := old.sent_at;
    new.finished_at := old.finished_at;
    new.recipients_count := old.recipients_count;
    new.devices_count := old.devices_count;
    new.sent_count := old.sent_count;
    new.delivered_count := old.delivered_count;
    new.read_count := old.read_count;
    new.failed_count := old.failed_count;

    if old.status in ('sending', 'sent') then
      if new.status is distinct from old.status
         or new.title is distinct from old.title
         or new.message is distinct from old.message
         or new.action_url is distinct from old.action_url
         or new.translations is distinct from old.translations
         or new.segments is distinct from old.segments
         or new.scheduled_at is distinct from old.scheduled_at then
        raise exception 'Уведомление уже отправлено — изменить его нельзя'
          using errcode = '22023';
      end if;
    elsif new.status not in ('draft', 'scheduled') then
      raise exception 'Уведомления отправляет сервер: сохраните уведомление запланированным'
        using errcode = '22023';
    end if;
  end if;

  if new.status = 'scheduled' and new.scheduled_at is null then
    new.scheduled_at := now();
  end if;
  return new;
end;
$$;

-- 4. Подстановка переменных ----------------------------------------------------------

-- Перевод поля контента: язык → английский → русский (как в приложении).
create or replace function public.push_tr(p_translations jsonb, p_field text, p_lang text, p_ru text)
returns text
language sql
immutable
as $$
  select coalesce(
    case when p_lang in ('en', 'ka') then nullif(btrim(p_translations -> p_lang ->> p_field), '') end,
    case when p_lang = 'ka' then nullif(btrim(p_translations -> 'en' ->> p_field), '') end,
    p_ru,
    ''
  )
$$;

-- «сегодня в 18:00» / «завтра в 09:30» / «17.10 в 18:00» по Тбилиси.
create or replace function public.push_trigger_when(p_ts timestamptz, p_lang text, p_now timestamptz default now())
returns text
language sql
stable
as $$
  with x as (
    select (p_ts at time zone 'Asia/Tbilisi') as l,
           (p_now at time zone 'Asia/Tbilisi')::date as today
  )
  select case
           when l::date = today then
             case p_lang when 'en' then 'today at ' when 'ka' then 'დღეს ' else 'сегодня в ' end
           when l::date = today + 1 then
             case p_lang when 'en' then 'tomorrow at ' when 'ka' then 'ხვალ ' else 'завтра в ' end
           else
             to_char(l, 'DD.MM')
             || case p_lang when 'en' then ' at ' when 'ka' then ', ' else ' в ' end
         end
         || to_char(l, 'HH24:MI')
         || case when p_lang = 'ka' then '-ზე' else '' end
    from x
$$;

-- Переменные текста на трёх языках: {"ru": {...}, "en": {...}, "ka": {...}}.
-- name — имя с карточки, club — клуб, у занятия — class/when/date/time/trainer,
-- у абонемента — membership, p_date — date (дата окончания, платежа…),
-- p_extra — общие для языков (days, left, amount).
create or replace function public.push_trigger_vars(
  p_client uuid,
  p_studio uuid,
  p_entry uuid default null,
  p_membership uuid default null,
  p_date date default null,
  p_extra jsonb default '{}'::jsonb,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_name text;
  v_studio record;
  v_entry record;
  v_trainer record;
  v_membership record;
  v_out jsonb := '{}'::jsonb;
  v jsonb;
  l text;
begin
  select coalesce(
           nullif(btrim(c.first_name), ''),
           nullif(split_part(btrim(c.full_name), ' ', 2), ''),
           nullif(btrim(c.full_name), ''),
           '')
    into v_name
    from public.clients c where c.id = p_client;

  select s.name, s.translations into v_studio from public.studios s where s.id = p_studio;

  if p_entry is not null then
    select e.starts_at, e.kind, e.title, w.name as workout_name, w.translations as workout_tr
      into v_entry
      from public.schedule_entries e
      left join public.workouts w on w.id = e.workout_id
     where e.id = p_entry;
    -- На замене — заменяющий (он и есть тренер занятия).
    select t.full_name, t.translations into v_trainer
      from public.trainers t
     where t.id = coalesce(
       (select su.trainer_id from public.schedule_entry_substitutions su
         where su.entry_id = p_entry order by su.created_at desc limit 1),
       (select et.trainer_id from public.schedule_entry_trainers et
          join public.trainers tt on tt.id = et.trainer_id
         where et.entry_id = p_entry order by tt.full_name limit 1)
     );
  end if;

  if p_membership is not null then
    select m.name, m.translations into v_membership from public.memberships m where m.id = p_membership;
  end if;

  foreach l in array array['ru', 'en', 'ka'] loop
    v := jsonb_build_object(
      'name', coalesce(v_name, ''),
      'club', public.push_tr(v_studio.translations, 'name', l, v_studio.name)
    );
    if p_entry is not null then
      v := v || jsonb_build_object(
        'class', case
                   when v_entry.kind = 'personal' then
                     case l when 'en' then 'Personal training' when 'ka' then 'პერსონალური ვარჯიში'
                            else 'Персональная тренировка' end
                   -- 2026-10-15_zz_diagnostics_client_requests.sql (идёт по имени позже).
                   when v_entry.kind = 'diagnostic' then
                     case l when 'en' then 'Body diagnostics' when 'ka' then 'სხეულის დიაგნოსტიკა'
                            else 'Диагностика тела' end
                   else public.push_tr(v_entry.workout_tr, 'name', l,
                                       coalesce(v_entry.workout_name, v_entry.title, ''))
                 end,
        'when', public.push_trigger_when(v_entry.starts_at, l, p_now),
        'date', to_char(v_entry.starts_at at time zone 'Asia/Tbilisi', 'DD.MM'),
        'time', to_char(v_entry.starts_at at time zone 'Asia/Tbilisi', 'HH24:MI'),
        'trainer', public.push_tr(v_trainer.translations, 'full_name', l, v_trainer.full_name)
      );
    end if;
    if p_membership is not null then
      v := v || jsonb_build_object(
        'membership', public.push_tr(v_membership.translations, 'name', l, v_membership.name));
    end if;
    if p_date is not null then
      v := v || jsonb_build_object('date', to_char(p_date, 'DD.MM'));
    end if;
    v_out := v_out || jsonb_build_object(l, v || coalesce(p_extra, '{}'::jsonb));
  end loop;
  return v_out;
end;
$$;

-- Шаблон с {переменными}. Пустое имя: «, ждём вас…» → «Ждём вас…».
create or replace function public.push_trigger_render(p_tpl text, p_vars jsonb)
returns text
language plpgsql
immutable
as $$
declare
  r record;
  v_out text := coalesce(p_tpl, '');
  v_trimmed text;
begin
  for r in select key, value from jsonb_each_text(coalesce(p_vars, '{}'::jsonb)) loop
    v_out := replace(v_out, '{' || r.key || '}', coalesce(r.value, ''));
  end loop;
  v_out := btrim(regexp_replace(v_out, '[ ]{2,}', ' ', 'g'));
  v_trimmed := regexp_replace(v_out, '^[,.!:;—–-]+\s*', '');
  if v_trimmed <> v_out and v_trimmed <> '' then
    v_out := upper(left(v_trimmed, 1)) || substr(v_trimmed, 2);
  end if;
  return v_out;
end;
$$;

-- 5. Отправка одного срабатывания ---------------------------------------------------

-- Уже отправлено этому человеку по этому событию — false. Иначе — строка
-- push_notifications (сразу «Отправляется» или «Отправлено», если телефонов
-- нет), получатель для ленты и доставки на его телефоны.
create or replace function public.push_trigger_send(
  p_trigger public.push_triggers,
  p_user uuid,
  p_studio uuid,
  p_ref text,
  p_vars jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_tr jsonb := '{}'::jsonb;
  v_lang text;
  v_title text;
  v_message text;
  v_devices integer;
begin
  if p_user is null or p_ref is null then
    return false;
  end if;

  insert into public.push_trigger_log (trigger_key, user_id, ref)
  values (p_trigger.key, p_user, p_ref)
  on conflict do nothing;
  if not found then
    return false;
  end if;

  foreach v_lang in array array['en', 'ka'] loop
    v_title := nullif(btrim(p_trigger.translations -> v_lang ->> 'title'), '');
    v_message := nullif(btrim(p_trigger.translations -> v_lang ->> 'message'), '');
    if v_title is not null or v_message is not null then
      v_tr := v_tr || jsonb_build_object(v_lang, jsonb_strip_nulls(jsonb_build_object(
        'title', case when v_title is not null then public.push_trigger_render(v_title, p_vars -> v_lang) end,
        'message', case when v_message is not null then public.push_trigger_render(v_message, p_vars -> v_lang) end
      )));
    end if;
  end loop;

  select count(*) into v_devices from public.push_subscriptions where user_id = p_user;

  insert into public.push_notifications (
    studio_id, studio_ids, title, message, action_url, translations, segments,
    status, scheduled_at, sent_at, finished_at, recipients_count, devices_count, trigger_key
  )
  values (
    p_studio,
    array[p_studio],
    public.push_trigger_render(p_trigger.title, p_vars -> 'ru'),
    nullif(public.push_trigger_render(p_trigger.message, p_vars -> 'ru'), ''),
    p_trigger.action_url,
    v_tr,
    '{}'::text[],
    case when v_devices = 0 then 'sent' else 'sending' end,
    now(),
    now(),
    case when v_devices = 0 then now() end,
    1,
    v_devices,
    p_trigger.key
  )
  returning id into v_id;

  insert into public.push_recipients (notification_id, user_id) values (v_id, p_user);

  insert into public.push_deliveries (notification_id, subscription_id, user_id)
  select v_id, s.id, s.user_id from public.push_subscriptions s where s.user_id = p_user
  on conflict do nothing;

  update public.push_trigger_log
     set notification_id = v_id
   where trigger_key = p_trigger.key and user_id = p_user and ref = p_ref;
  return true;
end;
$$;

-- Время напоминания: за p_hours до начала; ночью (22:00–09:00 по Тбилиси) —
-- в 09:00, если до начала остаётся хотя бы полчаса, иначе накануне в 21:00.
create or replace function public.push_trigger_reminder_at(p_starts timestamptz, p_hours integer)
returns timestamptz
language sql
immutable
as $$
  with x as (
    select ((p_starts - make_interval(hours => p_hours)) at time zone 'Asia/Tbilisi') as l
  )
  select case
           when extract(hour from l) >= 22 then
             (l::date + time '21:00') at time zone 'Asia/Tbilisi'
           when extract(hour from l) < 9 then
             case
               when ((l::date + time '09:00') at time zone 'Asia/Tbilisi') <= p_starts - interval '30 minutes'
                 then (l::date + time '09:00') at time zone 'Asia/Tbilisi'
               else ((l::date - 1) + time '21:00') at time zone 'Asia/Tbilisi'
             end
           else l at time zone 'Asia/Tbilisi'
         end
    from x
$$;

-- 6. Проход по триггерам --------------------------------------------------------------

-- Возвращает, сколько уведомлений создано. p_now — для тестов (по умолчанию
-- сейчас). Не больше 500 срабатываний триггера за проход — остальные уйдут
-- в следующий.
create or replace function public.push_triggers_run(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.push_triggers;
  r record;
  v_sent integer := 0;
  v_local timestamp := p_now at time zone 'Asia/Tbilisi';
  v_today date := (p_now at time zone 'Asia/Tbilisi')::date;
  v_hour integer := extract(hour from (p_now at time zone 'Asia/Tbilisi'))::integer;
  -- Ночью не шлём необязательное — уйдёт утром (окна событий — сутки и больше).
  v_quiet boolean := v_hour < 9 or v_hour >= 22;
  v_daily boolean;
  v_n integer;
  v_since timestamptz;
begin
  -- Два сервера при выкатке: второй просто пропускает проход.
  if not pg_try_advisory_xact_lock(hashtext('push_triggers_run')) then
    return 0;
  end if;

  delete from public.push_trigger_log where created_at < p_now - interval '400 days';

  for t in
    select * from public.push_triggers pt
     where pt.enabled
       and exists (select 1 from public.studios s where s.format = pt.format)
     order by pt.format, pt.key
  loop
    v_daily := v_hour >= coalesce((t.params ->> 'send_hour')::integer, 11) and v_hour < 22;

    case t.key

    -- Напоминание о занятии за N часов (ночное — утром или накануне вечером).
    -- Записавшимся позже момента напоминания не шлём: они только что записались.
    when 'class_reminder' then
      v_n := coalesce((t.params ->> 'hours')::integer, 3);
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id
          from public.schedule_bookings b
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
         where b.status = 'booked'
           and e.cancelled_at is null
           and coalesce(e.kind, 'group') in ('group', 'personal', 'diagnostic')
           and e.starts_at > p_now
           and e.starts_at <= p_now + make_interval(hours => v_n + 13)
           and public.push_trigger_reminder_at(e.starts_at, v_n) <= p_now
           and coalesce(b.booked_at, b.created_at) <= public.push_trigger_reminder_at(e.starts_at, v_n)
           and u.user_id is not null
         order by u.user_id, b.entry_id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.entry_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Записал не сам клиент (администратор в админке).
    when 'booked_for_client' then
      v_since := greatest(t.active_since, p_now - interval '6 hours');
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id,
               b.id::text || ':' || floor(extract(epoch from b.booked_at))::bigint::text as ref
          from public.schedule_bookings b
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
         where b.status = 'booked'
           and b.booked_at >= v_since
           and b.booked_at <= p_now
           and b.booked_by is not null
           and b.booked_by is distinct from u.user_id
           and e.cancelled_at is null
           and e.starts_at > p_now
           and u.user_id is not null
         order by u.user_id, b.entry_id, b.booked_at desc
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.ref,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Клуб отменил занятие: записи переведены в «Отменено» тем же
    -- cancel_schedule_entry (cancelled_at записи = cancelled_at занятия).
    when 'class_cancelled' then
      v_since := greatest(t.active_since, p_now - interval '24 hours');
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id,
               b.entry_id::text || ':' || floor(extract(epoch from e.cancelled_at))::bigint::text as ref
          from public.schedule_entries e
          join public.studios s on s.id = e.studio_id and s.format = t.format
          join public.schedule_bookings b on b.entry_id = e.id
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
         where e.cancelled_at >= v_since
           and e.cancelled_at <= p_now
           and e.starts_at > p_now
           and b.status = 'cancelled'
           and b.cancelled_at = e.cancelled_at
           and u.user_id is not null
         order by u.user_id, b.entry_id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.ref,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Замена тренера — тем, кто записался до замены.
    when 'trainer_substitution' then
      v_since := greatest(t.active_since, p_now - interval '24 hours');
      for r in
        select distinct on (u.user_id, b.entry_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id,
               b.entry_id::text || ':' || su.trainer_id::text as ref
          from public.schedule_entry_substitutions su
          join public.schedule_entries e on e.id = su.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          join public.schedule_bookings b on b.entry_id = e.id
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
         where su.created_at >= v_since
           and su.created_at <= p_now
           and e.cancelled_at is null
           and e.starts_at > p_now
           and b.status = 'booked'
           and coalesce(b.booked_at, b.created_at) < su.created_at
           and u.user_id is not null
         order by u.user_id, b.entry_id, su.created_at desc
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.ref,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Абонемент по продаже (в админке или в приложении) выдан.
    when 'membership_activated' then
      v_since := greatest(t.active_since, p_now - interval '24 hours');
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
         where cm.sale_id is not null
           and cm.created_at >= v_since
           and cm.created_at <= p_now
           and cm.status in ('active', 'pending')
           and c.user_id is not null
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Срок абонемента кончается через N дней, продления нет (ни ждущего, ни
    -- автопродления). Пробный — не в счёт.
    when 'membership_expiring' then
      continue when not v_daily;
      v_n := coalesce((t.params ->> 'days')::integer, 3);
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id, cm.ends_at
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
          join public.memberships m on m.id = cm.membership_id
         where cm.status = 'active'
           and cm.ends_at between v_today and v_today + v_n
           and not coalesce(cm.auto_renew, false)
           and coalesce(m.kind, 'package') <> 'trial'
           and c.user_id is not null
           and not exists (
             select 1 from public.client_memberships nx
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nx.balance_kind, 'group') = coalesce(cm.balance_kind, 'group')
                and nx.status in ('pending', 'active', 'frozen')
                and (nx.status = 'pending' or nx.ends_at is null or nx.ends_at > cm.ends_at)
           )
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, r.ends_at,
               jsonb_build_object('days', (r.ends_at - v_today)::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Срок абонемента вышел 1–3 дня назад, другого действующего нет.
    when 'membership_ended' then
      continue when not v_daily;
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id, cm.ends_at
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
          join public.memberships m on m.id = cm.membership_id
         where cm.status in ('active', 'expired')
           and cm.ends_at between v_today - 3 and v_today - 1
           -- Закончился по сроку: отхоженный (остаток 0) — не «срок вышел».
           and coalesce(case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end, 1) > 0
           and cm.ends_at >= (t.active_since at time zone 'Asia/Tbilisi')::date - 1
           and coalesce(m.kind, 'package') <> 'trial'
           and c.user_id is not null
           and not exists (
             select 1 from public.client_memberships nx
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nx.balance_kind, 'group') = coalesce(cm.balance_kind, 'group')
                and nx.status in ('pending', 'active', 'frozen')
           )
           -- О закончившихся тренировках уже сказали.
           and not exists (
             select 1 from public.push_trigger_log lg
              where lg.trigger_key = 'visits_exhausted' and lg.user_id = c.user_id and lg.ref = cm.id::text
           )
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, r.ends_at, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Пакетные: после списания осталось N тренировок или меньше (не ноль).
    when 'visits_low', 'visits_exhausted' then
      continue when v_quiet;
      v_n := coalesce((t.params ->> 'left')::integer, 2);
      v_since := greatest(t.active_since, p_now - interval '3 days');
      for r in
        select distinct on (c.user_id, cm.id)
               c.user_id, c.id as client_id, cm.studio_id, cm.id as cm_id, cm.membership_id,
               case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end as balance
          from public.client_memberships cm
          join public.clients c on c.id = cm.client_id
          join public.studios s on s.id = cm.studio_id and s.format = t.format
          join public.memberships m on m.id = cm.membership_id
         -- Пробное и разовое посещение (2026-10-15_zz_packages_single_visit.sql) — не в счёт.
         where coalesce(m.kind, 'package') not in ('trial', 'single')
           and c.user_id is not null
           and case when t.key = 'visits_low'
                    then cm.status = 'active'
                         and (case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end)
                             between 1 and v_n
                         and (case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end)
                             < coalesce(case when cm.balance_kind = 'personal' then m.personal_count else m.visits_count end, 0)
                    else cm.status in ('active', 'expired')
                         and (case when cm.balance_kind = 'personal' then cm.personal_left else cm.visits_left end) = 0
               end
           -- Тренировка списана недавно (после включения триггера).
           and exists (
             select 1 from public.schedule_bookings b
               join public.schedule_entries e on e.id = b.entry_id
              where b.charged_membership_id = cm.id
                and b.status in ('attended', 'no_show')
                and coalesce(b.charged_balance, '') <> 'diagnostic'
                and e.starts_at >= v_since
                and e.starts_at <= p_now
           )
           -- Продление уже куплено.
           and not exists (
             select 1 from public.client_memberships nx
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nx.balance_kind, 'group') = coalesce(cm.balance_kind, 'group')
                and nx.status in ('pending', 'active', 'frozen')
           )
         order by c.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, null,
               jsonb_build_object('left', r.balance::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Через N часов после пробной тренировки, если абонемент ещё не купили.
    when 'trial_followup' then
      continue when v_quiet;
      v_n := coalesce((t.params ->> 'hours')::integer, 3);
      v_since := greatest(t.active_since, p_now - interval '48 hours');
      for r in
        select distinct on (u.user_id, cm.id)
               u.user_id, cm.client_id, e.studio_id, cm.id as cm_id
          from public.schedule_bookings b
          join public.client_memberships cm on cm.id = b.charged_membership_id
          join public.memberships m on m.id = cm.membership_id and m.kind = 'trial'
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          join public.clients c on c.id = cm.client_id
          cross join lateral (select coalesce(b.user_id, c.user_id) as user_id) u
         where b.status = 'attended'
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') >= v_since
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') + make_interval(hours => v_n) <= p_now
           and u.user_id is not null
           and not exists (
             select 1 from public.client_memberships nx
               join public.memberships nm on nm.id = nx.membership_id
              where nx.client_id = cm.client_id
                and nx.id <> cm.id
                and coalesce(nm.kind, 'package') <> 'trial'
                and nx.created_at > cm.created_at
           )
         order by u.user_id, cm.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.cm_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Через N часов после посещения — оценить тренера (раз на тренера, пока
    -- клиент его не оценил).
    when 'rate_trainer' then
      continue when v_quiet;
      v_n := coalesce((t.params ->> 'hours')::integer, 2);
      v_since := greatest(t.active_since, p_now - interval '48 hours');
      for r in
        select distinct on (u.user_id, tr.trainer_id)
               u.user_id, u.client_id, e.studio_id, b.entry_id, tr.trainer_id
          from public.schedule_bookings b
          join public.schedule_entries e on e.id = b.entry_id
          join public.studios s on s.id = e.studio_id and s.format = t.format
          left join public.clients c on c.id = b.client_id
          cross join lateral (
            select coalesce(b.user_id, c.user_id) as user_id,
                   coalesce(c.id, (select c2.id from public.clients c2
                                    where c2.user_id = b.user_id order by c2.created_at limit 1)) as client_id
          ) u
          cross join lateral (
            select coalesce(
              (select su.trainer_id from public.schedule_entry_substitutions su
                where su.entry_id = e.id order by su.created_at desc limit 1),
              (select et.trainer_id from public.schedule_entry_trainers et
                 join public.trainers tt on tt.id = et.trainer_id
                where et.entry_id = e.id order by tt.full_name limit 1)
            ) as trainer_id
          ) tr
          join public.trainers trn on trn.id = tr.trainer_id
         where b.status = 'attended'
           and coalesce(trn.role, 'trainer') in ('trainer', 'masseur')
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') >= v_since
           and coalesce(e.ends_at, e.starts_at + interval '1 hour') + make_interval(hours => v_n) <= p_now
           and u.user_id is not null
           and not exists (
             select 1 from public.trainer_reviews rv
              where rv.trainer_id = tr.trainer_id and rv.user_id = u.user_id
           )
         order by u.user_id, tr.trainer_id, e.starts_at desc
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.trainer_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, r.entry_id, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- Платёж по рассрочке через N дней (0 — в день платежа) или просрочен
    -- на N дней (неделю после — не напоминаем).
    when 'installment_due', 'installment_overdue' then
      continue when not v_daily;
      v_n := coalesce((t.params ->> 'days')::integer, 1);
      for r in
        select distinct on (c.user_id, i.id)
               c.user_id, c.id as client_id, sa.studio_id, i.id as installment_id,
               sa.membership_id, i.due_date, i.amount
          from public.sale_installments i
          join public.sales sa on sa.id = i.sale_id
          join public.clients c on c.id = sa.client_id
          join public.studios s on s.id = sa.studio_id and s.format = t.format
         where not i.paid
           and not coalesce(i.refunded, false)
           and c.user_id is not null
           and case when t.key = 'installment_due'
                    then i.due_date between v_today and v_today + v_n
                    else i.due_date between v_today - v_n - 7 and v_today - greatest(v_n, 1)
               end
         order by c.user_id, i.id
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.installment_id::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, r.membership_id, r.due_date,
               jsonb_build_object('amount', trim_scale(r.amount)::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- С действующим абонементом, но без посещений N дней (неделю после — не
    -- пишем) и без будущих записей.
    when 'no_visits' then
      continue when not v_daily;
      v_n := coalesce((t.params ->> 'days')::integer, 14);
      for r in
        with live as (
          select distinct on (c.user_id)
                 c.user_id, c.id as client_id, c.studio_id
            from public.client_memberships cm
            join public.clients c on c.id = cm.client_id
            join public.studios s on s.id = c.studio_id and s.format = t.format
           where cm.status = 'active'
             and c.user_id is not null
           order by c.user_id, c.created_at
        ),
        last_visit as (
          select live.*,
                 (select max((e.starts_at at time zone 'Asia/Tbilisi')::date)
                    from public.schedule_bookings b
                    join public.schedule_entries e on e.id = b.entry_id
                   where b.status = 'attended'
                     and (b.user_id = live.user_id
                          or b.client_id in (select c3.id from public.clients c3 where c3.user_id = live.user_id))
                 ) as visit_date
            from live
        )
        select lv.*
          from last_visit lv
         where lv.visit_date between v_today - v_n - 7 and v_today - v_n
           and not exists (
             select 1 from public.schedule_bookings b
               join public.schedule_entries e on e.id = b.entry_id
              where b.status = 'booked'
                and e.starts_at > p_now
                and e.cancelled_at is null
                and (b.user_id = lv.user_id
                     or b.client_id in (select c3.id from public.clients c3 where c3.user_id = lv.user_id))
           )
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, r.visit_date::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, null, r.visit_date,
               jsonb_build_object('days', (v_today - r.visit_date)::text), p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    -- День рождения: карточка клиента или анкета приложения.
    when 'birthday' then
      continue when not v_daily;
      for r in
        select distinct on (c.user_id)
               c.user_id, c.id as client_id, c.studio_id
          from public.clients c
          join public.studios s on s.id = c.studio_id and s.format = t.format
          left join public.member_profiles mp on mp.user_id = c.user_id
         where c.user_id is not null
           and to_char(coalesce(c.birthday, mp.birth_date), 'MM-DD') = to_char(v_today, 'MM-DD')
         order by c.user_id, c.created_at
         limit 500
      loop
        if public.push_trigger_send(t, r.user_id, r.studio_id, extract(year from v_today)::text,
             public.push_trigger_vars(r.client_id, r.studio_id, null, null, null, '{}', p_now)) then
          v_sent := v_sent + 1;
        end if;
      end loop;

    else
      null;
    end case;
  end loop;

  return v_sent;
end;
$$;

revoke all on function public.push_trigger_vars(uuid, uuid, uuid, uuid, date, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.push_trigger_send(public.push_triggers, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.push_triggers_run(timestamptz) from public, anon, authenticated;
grant execute on function public.push_trigger_vars(uuid, uuid, uuid, uuid, date, jsonb, timestamptz) to service_role;
grant execute on function public.push_trigger_send(public.push_triggers, uuid, uuid, text, jsonb) to service_role;
grant execute on function public.push_triggers_run(timestamptz) to service_role;

-- 7. Статистика для админки -------------------------------------------------------------

-- Сколько срабатываний за период по триггерам формата. security invoker:
-- считаются только уведомления своих клубов (RLS push_notifications).
create or replace function public.push_trigger_stats(p_format text, p_since timestamptz)
returns table (
  trigger_key text,
  notifications integer,
  devices integer,
  sent integer,
  delivered integer,
  opened integer
)
language sql
stable
security invoker
set search_path = public
as $$
  select n.trigger_key,
         count(*)::integer,
         coalesce(sum(n.devices_count), 0)::integer,
         coalesce(sum(n.sent_count), 0)::integer,
         coalesce(sum(n.delivered_count), 0)::integer,
         coalesce(sum(n.read_count), 0)::integer
    from public.push_notifications n
   where n.trigger_key is not null
     and n.created_at >= p_since
     and exists (
       select 1 from public.studios s
        where s.id = any(n.studio_ids) and s.format = p_format
     )
   group by n.trigger_key
$$;

revoke all on function public.push_trigger_stats(text, timestamptz) from public, anon;
grant execute on function public.push_trigger_stats(text, timestamptz) to authenticated;

notify pgrst, 'reload schema';

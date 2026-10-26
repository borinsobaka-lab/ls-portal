-- ============================================================================
-- Массажисты и администраторы в приложении пакетных студий, число
-- специалистов в «О нас» (решение владельца 2026-10-12):
--
-- 1. Новая роль сотрудника — «Массажист» (trainers.role = 'masseur'): в
--    «Сотрудниках» админки рядом с тренером и администратором, клубы —
--    trainer_studios, как у всех. В приложении — вкладка «Массажисты» раздела
--    «Студия»: рейтинг (прежний сервис + оценки клиентов) и чаевые, как у
--    тренеров. Администраторы — вкладка «Администраторы»: описание и чаевые,
--    без рейтинга.
-- 2. Оценить можно только тренера или массажиста (client_can_rate_trainer —
--    актуальное определение здесь): администраторов в приложении не оценивают.
-- 3. app_about_settings.specialists_count — «N специалистов работают над тем,
--    чтобы делать жизнь наших клиенток лучше» (плитка в цифрах «О нас»,
--    правится в админке там же); пакетному приложению — 18.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Роль «Массажист» -----------------------------------------------------------

-- Прежняя проверка роли (2026-10-10_staff_directory.sql) создана без имени —
-- снимаем любую проверку колонки role и ставим свою.
do $$
declare
  _c text;
begin
  for _c in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.trainers'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ~ '\mrole\M'
  loop
    execute format('alter table public.trainers drop constraint %I', _c);
  end loop;
end;
$$;

alter table public.trainers add constraint trainers_role_check
  check (role in ('trainer', 'admin', 'masseur'));

comment on column public.trainers.role is
  'Кем работает сотрудник: trainer — тренер, admin — администратор, masseur — массажист.';

-- 2. Оценки — только тренерам и массажистам -----------------------------------

create or replace function public.client_can_rate_trainer(_trainer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.trainer_studios ts
      join public.trainers t on t.id = ts.trainer_id
     where ts.trainer_id = _trainer_id
       and t.role in ('trainer', 'masseur')
       and (
         ts.studio_id = public.current_studio_id(auth.uid())
         or public.client_can_browse_studio(ts.studio_id)
       )
  )
$$;

revoke all on function public.client_can_rate_trainer(uuid) from public;
grant execute on function public.client_can_rate_trainer(uuid) to authenticated;

-- 3. Число специалистов в «О нас» ---------------------------------------------

alter table public.app_about_settings
  add column if not exists specialists_count integer;

alter table public.app_about_settings
  drop constraint if exists app_about_settings_specialists_count_check;
alter table public.app_about_settings
  add constraint app_about_settings_specialists_count_check
  check (specialists_count is null or specialists_count > 0);

comment on column public.app_about_settings.specialists_count is
  'Сколько специалистов работают над тем, чтобы делать жизнь клиенток лучше (плитка «О нас»). null — не показывается.';

-- Цифра от владельца (2026-10-12): 18 человек. Повторный прогон не затирает
-- исправленное в админке.
insert into public.app_about_settings (format, specialists_count)
values ('packages', 18)
on conflict (format) do update
  set specialists_count = 18
  where public.app_about_settings.specialists_count is null;

notify pgrst, 'reload schema';

-- ============================================================================
-- «Аналитика» без связи со старым порталом (решение владельца 2026-10-29,
-- уточнение к ANALYTICS_PLAN.md того же дня): новый портал повторяет логику
-- старого портала аналитики Lady Stretch, но данные берёт сам — свои
-- подключения к 1С, FitBase, amoCRM, VK, Авито. Старый портал работает
-- параллельно только для сверки цифр. Поэтому удаляется всё, что связывало
-- порталы (2026-10-29_z_analytics_core.sql):
--
--   * зеркало ядра старого портала an_legacy_* и перенос людей оттуда
--     (an_legacy_people, an_legacy_link) — люди и роли заводятся в
--     «Пользователях и ролях», города партнёров — в «Аналитике»;
--   * приём синхронизации от агента (an_replica_targets, an_replica_log,
--     an_replica_apply, an_replica_status, an_replica_agent,
--     an_replica_log_cleanup);
--   * режимы модулей «Зеркало / Проверка / Основной» (an_modules,
--     an_modules_list, an_module_set) — каждый модуль работает на своих
--     сборщиках сразу.
--
-- an_me_for — актуальное определение здесь: ФИО таргетолога — из профиля.
-- Фоновые задачи: an_job_set_enabled — включить или выключить задачу
-- (задачи с внешними действиями — Telegram, Google-таблицы, публикации VK —
-- сервер по умолчанию не запускает, пока их не включат: старый портал
-- делает то же самое, были бы дубли).
--
-- Данных в этих таблицах в боевой базе не было: агент не ставился.
-- ============================================================================

-- 1) Функции (до таблиц: an_modules_list и an_replica_status читают их).
drop function if exists public.an_legacy_people();
drop function if exists public.an_legacy_link(bigint, uuid);
drop function if exists public.an_replica_apply(text, jsonb, jsonb);
drop function if exists public.an_replica_status();
drop function if exists public.an_replica_agent();
drop function if exists public.an_replica_log_cleanup();
drop function if exists public.an_modules_list();
drop function if exists public.an_module_set(text, text);

-- 2) Что открыто человеку — без ФИО со старого портала.
-- Что открыто человеку — их allowed_dashboards (app.py) на правах из ролей.
create or replace function public.an_me_for(_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_all text[] := array['onec.revenue', 'onec.sales', 'onec.classes', 'onec.trials', 'onec.zero',
    'onec.mycity', 'fb.revenue', 'fb.marketing', 'fb.sales', 'fb.attendance', 'fb.trials', 'fb.mycity',
    'mkt.ls', 'mkt.lj', 'vk.register', 'avito.register', 'reviews'];
  v_fb text[] := array['fb.revenue', 'fb.marketing', 'fb.sales', 'fb.attendance', 'fb.trials', 'fb.mycity'];
  v_rights text[];
  v_admin boolean;
  v_granted text[];
  v_cities text[];
  v_partner boolean;
  v_target text;
  v_reports text[];
  v_inbox boolean;
begin
  if _user_id is null then
    return null;
  end if;
  select coalesce(r.rights, '{}') into v_rights
    from public.access_user_rights r where r.user_id = _user_id and r.portal;
  v_rights := coalesce(v_rights, '{}');
  v_admin := 'an.admin' = any (v_rights) or 'portal.admin' = any (v_rights);
  v_granted := array(select substr(x, 4) from unnest(v_rights) x
                      where x like 'an.%' and substr(x, 4) = any (v_all));
  select array_agg(city order by city) into v_cities
    from public.an_partner_cities where user_id = _user_id;
  v_partner := not v_admin and ('an.partner' = any (v_rights) or v_cities is not null);
  if not v_admin and 'an.targetologist' = any (v_rights) then
    -- ФИО — ключ назначений таргетологов (как у них).
    select nullif(btrim(full_name), '') into v_target from public.profiles where id = _user_id;
    v_target := coalesce(v_target, '');
  end if;

  if v_admin then
    v_reports := v_all;
  elsif v_target is not null then
    -- Таргетолог: реестр таргета и маркетинг всегда + всё выданное.
    v_reports := array(select distinct x from unnest(array['vk.register', 'mkt.ls', 'mkt.lj'] || v_granted) x);
  elsif v_partner then
    -- Партнёр: «Мой город» + маркетинг и отзывы + отчёты FitBase из выданного.
    v_reports := array(select distinct x from unnest(
      array['onec.mycity']
      || array(select g from unnest(v_granted) g
                where g = any (array['mkt.ls', 'mkt.lj', 'reviews'] || v_fb))) x);
  else
    v_reports := v_granted;
  end if;
  v_inbox := v_admin or 'an.inbox' = any (v_rights);

  return jsonb_build_object(
    'visible', v_admin or cardinality(v_reports) > 0 or v_inbox,
    'admin', v_admin,
    'reports', to_jsonb(v_reports),
    'partner_cities', case when v_partner then to_jsonb(coalesce(v_cities, '{}')) end,
    'targetologist', v_target,
    'inbox', v_inbox
  );
end;
$$;
revoke all on function public.an_me_for(uuid) from public, anon, authenticated;
grant execute on function public.an_me_for(uuid) to service_role;

-- 3) Таблицы.
drop table if exists public.an_legacy_users;
drop table if exists public.an_legacy_dashboard_access;
drop table if exists public.an_legacy_partner_cities;
drop table if exists public.an_legacy_partner_profiles;
drop table if exists public.an_legacy_partner_city_settings;
drop table if exists public.an_legacy_fitbase_connections;
drop table if exists public.an_legacy_sessions;
drop table if exists public.an_legacy_activity;
drop table if exists public.an_legacy_audit;
drop table if exists public.an_replica_log;
drop table if exists public.an_replica_targets;
drop table if exists public.an_modules;

-- 4) Фоновые задачи: включить / выключить (администратор аналитики).
create or replace function public.an_job_set_enabled(p_job text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.an_require_admin();
  if p_job is null or char_length(p_job) not between 1 and 80 then
    raise exception 'an_bad_job' using errcode = '22023';
  end if;
  insert into public.an_job_state (job, enabled) values (p_job, p_enabled)
  on conflict (job) do update set enabled = excluded.enabled;
end;
$$;
revoke all on function public.an_job_set_enabled(text, boolean) from public, anon;
grant execute on function public.an_job_set_enabled(text, boolean) to authenticated, service_role;

notify pgrst, 'reload schema';

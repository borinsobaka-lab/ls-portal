-- ============================================================================
-- «Аналитика» → FitBase, часть 4 (ANALYTICS.md, «FitBase»): пробные занятия —
-- их fitbase_trial_services.py (выбор пробных услуг филиала, каталог услуг,
-- связи записей с услугами), fitbase_trial_basis.py (основания записей из
-- веб-интерфейса FitBase — заполнит сборщик, часть 5), fitbase_trials.py
-- (воронка пробных) и fitbase_trial_review.py («Записи без услуги» + CSV).
--
-- Тип записи (их products + overrides): 1 — пробная, 0 — обычная, -1 — не
-- определён. У них overrides считается при каждом открытии отчёта; здесь их
-- итог пишет сервер портала (an_fb_trial_overrides) после каждого события,
-- которое меняет его исходные данные: загрузки студии, сохранения выбора
-- услуг, обновления каталога, новых оснований. Отчёты читают
-- coalesce(override, an_fb_trial_products, -1).
--
-- Таблицы закрыты браузеру: администратору аналитики — RPC выбора услуг,
-- отчёты — по праву «Воронка пробных» (fb.trials, вся сеть, как у них),
-- серверу (service_role) — запись каталога, связей, оснований и типов.
--
-- Идемпотентно. Выполняет мигратор при старте портала (db/migrate.ts).
-- ============================================================================

-- Их owner(c): json.dumps([domain, str(club_id)]) — выбор и каталог не
-- переходят к другому клубу или домену подключения.
create or replace function public.an_fb_owner(p_domain text, p_club text)
returns text
language sql
immutable
set search_path = public
as $$
  select '[' || to_json(coalesce(p_domain, ''))::text || ', ' || to_json(coalesce(p_club, ''))::text || ']';
$$;
revoke all on function public.an_fb_owner(text, text) from public, anon, authenticated;

-- Их trial_service_rules: режим «auto» (флаг и название FitBase) или
-- «selected» (только отмеченные услуги), revision — защита от одновременной правки.
create table if not exists public.an_fb_trial_service_rules (
  connection_id bigint primary key references public.an_fb_connections(id) on delete cascade,
  owner text not null,
  mode text not null check (mode in ('auto', 'selected')),
  selected jsonb not null default '[]',
  revision integer not null default 0
);

-- Их trial_service_catalog: услуги филиала из FitBase (available-services).
create table if not exists public.an_fb_trial_service_catalog (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  owner text not null,
  service_id text not null,
  name text not null,
  is_trial integer not null,
  archived integer not null,
  primary key (connection_id, service_id)
);

-- Их trial_service_refs / trial_service_index: услуги каждой записи (из
-- выгрузок записей и активаций услуг) и метка исходных данных.
create table if not exists public.an_fb_trial_service_refs (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  owner text not null,
  registration_id text not null,
  service_ids jsonb not null,
  primary key (connection_id, registration_id)
);
create table if not exists public.an_fb_trial_service_index (
  connection_id bigint primary key references public.an_fb_connections(id) on delete cascade,
  owner text not null,
  stamp text not null
);

-- Их trial_browser_basis: основание записи из веб-интерфейса FitBase
-- (название выбранной услуги / абонемента) — только ID записи и занятия.
create table if not exists public.an_fb_trial_basis (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  owner text not null,
  registration_id text not null,
  event_id text not null,
  label text not null,
  captured_at bigint not null,
  imported_at bigint not null,
  primary key (connection_id, registration_id)
);

-- Итог их overrides(): тип записи по выбранным услугам и основаниям.
create table if not exists public.an_fb_trial_overrides (
  connection_id bigint not null references public.an_fb_connections(id) on delete cascade,
  owner text not null,
  registration_id text not null,
  kind smallint not null check (kind in (-1, 0, 1)),
  primary key (connection_id, registration_id)
);

alter table public.an_fb_trial_service_rules enable row level security;
alter table public.an_fb_trial_service_catalog enable row level security;
alter table public.an_fb_trial_service_refs enable row level security;
alter table public.an_fb_trial_service_index enable row level security;
alter table public.an_fb_trial_basis enable row level security;
alter table public.an_fb_trial_overrides enable row level security;
revoke all on public.an_fb_trial_service_rules, public.an_fb_trial_service_catalog,
  public.an_fb_trial_service_refs, public.an_fb_trial_service_index, public.an_fb_trial_basis,
  public.an_fb_trial_overrides
  from public, anon, authenticated;
grant select, insert, update, delete on public.an_fb_trial_service_rules,
  public.an_fb_trial_service_catalog, public.an_fb_trial_service_refs,
  public.an_fb_trial_service_index, public.an_fb_trial_basis, public.an_fb_trial_overrides
  to service_role;

-- Их отбор студий отчётов пробных: с клубом, под фильтрами, одна на пару
-- «домен + клуб» — с самой свежей загрузкой занятий.
create or replace function public.an_fb_trials_selected(p_city text, p_studio text, p_brand text)
returns bigint[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(s.id), '{}')
    from (select distinct on (c.domain, c.club_id) c.id
            from public.an_fb_connections c
           where c.club_id <> ''
             and (coalesce(p_city, '') = '' or c.city = p_city)
             and (coalesce(p_studio, '') = '' or c.id::text = p_studio)
             and (coalesce(p_brand, '') = '' or c.brand = p_brand)
           order by c.domain, c.club_id, coalesce(c.attendance_synced_at, 0) desc, c.id desc) s;
$$;
revoke all on function public.an_fb_trials_selected(text, text, text) from public, anon, authenticated;

-- Их attendance_window: ISO-даты, начало не позже конца, не больше 366 дней.
create or replace function public.an_fb_trials_window(p_from text, p_to text)
returns daterange
language plpgsql
immutable
set search_path = public
as $$
declare
  v_from date;
  v_to date;
begin
  begin
    if coalesce(p_from, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(p_to, '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad';
    end if;
    v_from := p_from::date;
    v_to := p_to::date;
  exception when others then
    raise exception 'Выберите период не больше 366 дней.' using errcode = '22023';
  end;
  if v_to < v_from or v_to - v_from >= 366 then
    raise exception 'Выберите период не больше 366 дней.' using errcode = '22023';
  end if;
  return daterange(v_from, v_to, '[]');
end;
$$;
revoke all on function public.an_fb_trials_window(text, text) from public, anon, authenticated;

-- «Воронка пробных» (их fitbase_trials.report): пробные записи за всё время
-- (атрибуция покупок глобальная), непробные платные абонементы клиентов с
-- посещённым пробным и их оплаты; расчёт — страница
-- (lib/analytics/fitbase/trials.ts, их calculate). У них в расчёт идут только
-- записи и абонементы с определённым типом; обычные записи на него не влияют.
create or replace function public.an_fb_trials_data(p_from text, p_to text, p_city text, p_studio text,
  p_brand text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_range daterange;
  v_sel bigint[];
  v_result jsonb;
begin
  if not public.an_fb_report_allowed('fb.trials') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  v_range := public.an_fb_trials_window(p_from, p_to);
  if coalesce(p_brand, '') not in ('', 'Lady Jump', 'Lady Stretch') then
    raise exception 'Проверьте направление.' using errcode = '22023';
  end if;
  v_sel := public.an_fb_trials_selected(p_city, p_studio, p_brand);

  with sel as (
    select c.id, public.an_fb_owner(c.domain, c.club_id) as owner,
           public.an_fb_effective_rules(c.attendance_rules) as rules
      from public.an_fb_connections c where c.id = any (v_sel)
  ), regs as (
    select r.connection_id, r.registration_id, r.client_key, r.status, e.day, e.end_at,
           coalesce((s.rules ->> r.status) = 'visited', false) as visited,
           coalesce(o.kind::int, p.is_trial, -1) as kind
      from public.an_fb_records r
      join sel s on s.id = r.connection_id
      join public.an_fb_events e on e.connection_id = r.connection_id and e.event_id = r.event_id
      left join public.an_fb_trial_overrides o
        on o.connection_id = r.connection_id and o.registration_id = r.registration_id and o.owner = s.owner
      left join public.an_fb_trial_products p
        on p.connection_id = r.connection_id and p.kind = 'registration' and p.item_id = r.registration_id
     where not e.cancelled
  ), trials as (
    select * from regs where kind = 1
  ), buyers as (
    select distinct connection_id, client_key from trials where visited and client_key <> ''
  ), sales as (
    select s.connection_id, s.contract_id, s.client_id, s.purchased_at, s.price_cents
      from public.an_fb_sales s
      join buyers b on b.connection_id = s.connection_id and b.client_key = s.client_id
      join public.an_fb_trial_products p
        on p.connection_id = s.connection_id and p.kind = 'contract' and p.item_id = s.contract_id
     where s.price_cents > 0 and p.is_trial = 0
  )
  select jsonb_build_object(
    'from', lower(v_range),
    'to', upper(v_range) - 1,
    'now', extract(epoch from now())::bigint,
    'admin', public.an_is_admin(auth.uid()),
    'batch', (select jsonb_build_object(
                'active', b.active and b.updated_at >= now() - interval '30 minutes',
                'message', coalesce(b.payload ->> 'message', ''))
                from public.an_fb_batch b where b.id = 1),
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'brand', c.brand)
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c),
    'selected', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city,
               'brand', c.brand, 'attendance_synced_at', c.attendance_synced_at,
               'attendance_from', c.attendance_from, 'attendance_to', c.attendance_to,
               'sales_payments_at', c.sales_payments_at, 'sales_synced_at', c.sales_synced_at)
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c where c.id = any (v_sel)),
    'records', (
      select coalesce(jsonb_agg(jsonb_build_array(t.connection_id, t.registration_id, t.client_key,
               t.visited, t.day, t.end_at)), '[]')
        from trials t),
    'sales', (
      select coalesce(jsonb_agg(jsonb_build_array(s.connection_id, s.contract_id, s.client_id,
               s.purchased_at, s.price_cents)), '[]')
        from sales s),
    'payments', (
      select coalesce(jsonb_agg(jsonb_build_array(p.connection_id, p.contract_id, p.operation,
               p.amount_cents, p.pay_at)), '[]')
        from public.an_fb_payments p
       where exists (select 1 from sales s where s.connection_id = p.connection_id and s.contract_id = p.contract_id)),
    'review_count', (
      select count(*) from regs r
       where r.kind < 0 and r.day >= lower(v_range)::text and r.day <= (upper(v_range) - 1)::text)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.an_fb_trials_data(text, text, text, text, text) from public, anon;
grant execute on function public.an_fb_trials_data(text, text, text, text, text) to authenticated;

-- «Записи без услуги / абонемента» (их fitbase_trial_review.data): записи
-- периода на неотменённые занятия, тип которых не определён; любой статус.
create or replace function public.an_fb_trials_review(p_from text, p_to text, p_city text, p_studio text,
  p_brand text, p_status text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_range daterange;
  v_sel bigint[];
  v_status text := coalesce(p_status, '');
begin
  if not public.an_fb_report_allowed('fb.trials') then
    raise exception 'an_forbidden' using errcode = '42501';
  end if;
  v_range := public.an_fb_trials_window(p_from, p_to);
  if coalesce(p_brand, '') not in ('', 'Lady Jump', 'Lady Stretch')
     or v_status not in ('', 'registered', 'confirmed', 'visited', 'no_show', 'late_cancel', 'refused',
                         'waiting', 'pending_payment', 'unknown') then
    raise exception 'Проверьте направление и статус.' using errcode = '22023';
  end if;
  v_sel := public.an_fb_trials_selected(p_city, p_studio, p_brand);
  return jsonb_build_object(
    'from', lower(v_range),
    'to', upper(v_range) - 1,
    'connections', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'city', c.city, 'brand', c.brand)
             order by c.brand collate "C", c.city collate "C", c.name collate "C", c.id), '[]')
        from public.an_fb_connections c),
    'rows', (
      select coalesce(jsonb_agg(jsonb_build_array(c.name, c.city, c.brand, e.day, e.end_at, e.training_name,
               x.status, e.event_id, r.registration_id)), '[]')
        from public.an_fb_connections c
        cross join lateral (select public.an_fb_owner(c.domain, c.club_id) as owner,
                                   public.an_fb_effective_rules(c.attendance_rules) as rules) k
        join public.an_fb_records r on r.connection_id = c.id
        join public.an_fb_events e on e.connection_id = r.connection_id and e.event_id = r.event_id
        left join public.an_fb_trial_overrides o
          on o.connection_id = r.connection_id and o.registration_id = r.registration_id and o.owner = k.owner
        left join public.an_fb_trial_products p
          on p.connection_id = r.connection_id and p.kind = 'registration' and p.item_id = r.registration_id
        cross join lateral (select coalesce(k.rules ->> r.status, 'unknown') as status) x
       where c.id = any (v_sel)
         and e.day >= lower(v_range)::text and e.day <= (upper(v_range) - 1)::text
         and not e.cancelled
         and coalesce(o.kind::int, p.is_trial, -1) < 0
         and (v_status = '' or x.status = v_status))
  );
end;
$$;
revoke all on function public.an_fb_trials_review(text, text, text, text, text, text) from public, anon;
grant execute on function public.an_fb_trials_review(text, text, text, text, text, text) to authenticated;

-- Настройка пробных услуг филиала (их fitbase_trial_services.render):
-- выбор и каталог текущего владельца подключения. Администратору аналитики.
create or replace function public.an_fb_trial_services(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.an_fb_connections;
  v_owner text;
begin
  perform public.an_require_admin();
  select * into c from public.an_fb_connections where id = p_id;
  if not found then
    return null;
  end if;
  v_owner := public.an_fb_owner(c.domain, c.club_id);
  return jsonb_build_object(
    'id', c.id, 'name', c.name, 'club_id', c.club_id, 'owner', v_owner,
    'rule', (select jsonb_build_object('mode', r.mode, 'selected', r.selected, 'revision', r.revision)
               from public.an_fb_trial_service_rules r where r.connection_id = c.id and r.owner = v_owner),
    'catalog', (select coalesce(jsonb_agg(jsonb_build_object('service_id', k.service_id, 'name', k.name,
                         'archived', k.archived)
                       order by k.archived, k.name collate "C", k.service_id collate "C"), '[]')
                  from public.an_fb_trial_service_catalog k
                 where k.connection_id = c.id and k.owner = v_owner));
end;
$$;
revoke all on function public.an_fb_trial_services(bigint) from public, anon;
grant execute on function public.an_fb_trial_services(bigint) to authenticated;

-- Их save(): режим, выбранные услуги из каталога филиала, revision.
create or replace function public.an_fb_trial_services_save(p_id bigint, p_owner text, p_mode text,
  p_selected jsonb, p_revision text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.an_fb_connections;
  v_owner text;
  v_ids text[];
  v_old public.an_fb_trial_service_rules;
  v_oldrev integer := 0;
begin
  perform public.an_require_admin();
  if coalesce(p_mode, '') not in ('auto', 'selected') then
    raise exception 'Проверьте режим.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_selected) <> 'array' then
    raise exception 'Проверьте режим.' using errcode = '22023';
  end if;
  select coalesce(array_agg(x.v order by x.v collate "C"), '{}') into v_ids
    from (select distinct v from jsonb_array_elements_text(p_selected) v) x;
  select * into c from public.an_fb_connections where id = p_id for update;
  v_owner := case when found then public.an_fb_owner(c.domain, c.club_id) else public.an_fb_owner('', '') end;
  if v_owner <> coalesce(p_owner, '') then
    raise exception 'Подключение изменилось. Откройте настройки заново.' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_ids) i
              where not exists (select 1 from public.an_fb_trial_service_catalog k
                                 where k.connection_id = p_id and k.owner = v_owner and k.service_id = i)) then
    raise exception 'Услуга отсутствует в каталоге этого филиала.' using errcode = '22023';
  end if;
  if p_mode = 'selected' and cardinality(v_ids) = 0 then
    raise exception 'Выберите хотя бы одну пробную услугу.' using errcode = '22023';
  end if;
  select * into v_old from public.an_fb_trial_service_rules where connection_id = p_id;
  if found and v_old.owner = v_owner then
    v_oldrev := v_old.revision;
  end if;
  if v_oldrev::text <> coalesce(p_revision, '') then
    raise exception 'Настройки уже изменены. Обновите страницу.' using errcode = '22023';
  end if;
  insert into public.an_fb_trial_service_rules (connection_id, owner, mode, selected, revision)
  values (p_id, v_owner, p_mode, to_jsonb(v_ids), v_oldrev + 1)
  on conflict (connection_id) do update
    set owner = excluded.owner, mode = excluded.mode, selected = excluded.selected, revision = excluded.revision;
  return v_oldrev + 1;
end;
$$;
revoke all on function public.an_fb_trial_services_save(bigint, text, text, jsonb, text) from public, anon;
grant execute on function public.an_fb_trial_services_save(bigint, text, text, jsonb, text) to authenticated;

-- Сервер: каталог услуг (их load_catalog, INSERT OR REPLACE; строки другого
-- владельца удаляются), связи записей, основания и итоговые типы.
create or replace function public.an_fb_trial_catalog_store(p_id bigint, p_owner text, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.an_fb_connections;
begin
  select * into c from public.an_fb_connections where id = p_id for update;
  if not found or public.an_fb_owner(c.domain, c.club_id) <> p_owner then
    raise exception 'Подключение изменилось. Откройте настройки заново.' using errcode = '22023';
  end if;
  delete from public.an_fb_trial_service_catalog where connection_id = p_id and owner <> p_owner;
  insert into public.an_fb_trial_service_catalog (connection_id, owner, service_id, name, is_trial, archived)
  select p_id, p_owner, x->>'service_id', x->>'name', (x->>'is_trial')::int, (x->>'archived')::int
    from jsonb_array_elements(p_rows) x
  on conflict (connection_id, service_id) do update
    set owner = excluded.owner, name = excluded.name, is_trial = excluded.is_trial, archived = excluded.archived;
end;
$$;
revoke all on function public.an_fb_trial_catalog_store(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_fb_trial_catalog_store(bigint, text, jsonb) to service_role;

create or replace function public.an_fb_trial_refs_store(p_id bigint, p_owner text, p_stamp text, p_refs jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.an_fb_trial_service_refs where connection_id = p_id;
  insert into public.an_fb_trial_service_refs (connection_id, owner, registration_id, service_ids)
  select p_id, p_owner, x->>0, x->1 from jsonb_array_elements(p_refs) x;
  insert into public.an_fb_trial_service_index (connection_id, owner, stamp)
  values (p_id, p_owner, p_stamp)
  on conflict (connection_id) do update set owner = excluded.owner, stamp = excluded.stamp;
end;
$$;
revoke all on function public.an_fb_trial_refs_store(bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_fb_trial_refs_store(bigint, text, text, jsonb) to service_role;

create or replace function public.an_fb_trial_overrides_store(p_id bigint, p_owner text, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.an_fb_trial_overrides where connection_id = p_id;
  insert into public.an_fb_trial_overrides (connection_id, owner, registration_id, kind)
  select p_id, p_owner, x->>0, (x->>1)::smallint from jsonb_array_elements(p_rows) x;
end;
$$;
revoke all on function public.an_fb_trial_overrides_store(bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.an_fb_trial_overrides_store(bigint, text, jsonb) to service_role;

-- «Рабочий день» — порядок рабочего дня администратора клуба (решение
-- владельца 2026-10-25): кнопка справа от поиска в шапке базы знаний
-- раскрывает список дел дня с ориентировочным временем, у пункта может быть
-- подробная инструкция (раскрывается). Пункты — свои у каждого клуба
-- (Сабуртало и Ваке различаются), отмечает выполненное любой сотрудник клуба;
-- отметка — на день (по Тбилиси), её видят все сотрудники клуба. Пункт со
-- временем, не отмеченный к этому времени, — просрочен (восклицательный знак
-- у пункта и на кнопке; считает браузер по времени Тбилиси).
--
--   workday_sections — блоки дня («Начало рабочего дня», «Рабочий день»…);
--   workday_items    — пункты: текст, время «к HH:MM» (null — без времени),
--                      подробная инструкция (текст с разметкой
--                      lib/formatted-text.tsx);
--   workday_checks   — отметки «выполнено»: пункт × день, кто и когда.
--
-- Читают и отмечают — сотрудники клуба (owner/admin/trainer), правят пункты и
-- блоки — владелец клуба (как прочие настройки клуба). Отметить и снять
-- отметку можно только за сегодня; история отметок остаётся (на будущий
-- отчёт). Стартовый набор — таблица Lady Stretch «Рабочий день»: клубам с
-- «Сабуртало» / «Ваке» в названии, если у клуба ещё нет блоков.

-- 1) Хелперы -------------------------------------------------------------------

-- Сегодня по Тбилиси (UTC+4, без перехода на летнее время).
create or replace function public.workday_today()
returns date
language sql
stable
set search_path = public
as $$
  select (now() at time zone 'Asia/Tbilisi')::date
$$;

-- Клубы, где вызывающий — владелец (правка пунктов). Массивом для политик,
-- как auth_staff_studio_ids (2026-10-16_zz_rls_initplan_perf.sql).
create or replace function public.auth_owner_studio_ids()
returns uuid[]
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (select coalesce(array_agg(distinct ur.studio_id), '{}'::uuid[])
            from public.user_roles ur
           where ur.user_id = auth.uid()
             and ur.role = 'owner');
end;
$$;

revoke all on function public.auth_owner_studio_ids() from public;
grant execute on function public.auth_owner_studio_ids() to authenticated, service_role;
grant execute on function public.workday_today() to authenticated, service_role;

-- 2) Таблицы -------------------------------------------------------------------

create table if not exists public.workday_sections (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists workday_sections_studio_idx
  on public.workday_sections (studio_id, sort_order);

create table if not exists public.workday_items (
  id uuid primary key default gen_random_uuid(),
  -- Клуб пункта — клуб его блока (ставит триггер).
  studio_id uuid not null references public.studios(id) on delete cascade,
  section_id uuid not null references public.workday_sections(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 500),
  details text check (details is null or char_length(details) <= 10000),
  due_time time,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create index if not exists workday_items_section_idx
  on public.workday_items (section_id, sort_order);
create index if not exists workday_items_studio_idx on public.workday_items (studio_id);

create table if not exists public.workday_checks (
  item_id uuid not null references public.workday_items(id) on delete cascade,
  day date not null,
  studio_id uuid not null references public.studios(id) on delete cascade,
  checked_by uuid references auth.users(id) on delete set null,
  -- Снимок имени: профили сотрудников других клубов RLS не отдаёт.
  checked_by_name text,
  checked_at timestamptz not null default now(),
  primary key (item_id, day)
);
create index if not exists workday_checks_studio_day_idx
  on public.workday_checks (studio_id, day);

-- 3) Триггеры ------------------------------------------------------------------

-- security definer — увидеть блок любого клуба: пункт в блок чужого клуба
-- не встанет (новый — RLS по клубу блока, перенос — workday_other_studio).
create or replace function public.workday_items_biu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_studio uuid;
begin
  select studio_id into v_studio from public.workday_sections where id = new.section_id;
  if v_studio is null then
    raise exception 'workday_section_not_found' using errcode = '23503';
  end if;
  if tg_op = 'UPDATE' and v_studio <> old.studio_id then
    raise exception 'workday_other_studio' using errcode = '23514';
  end if;
  new.studio_id := v_studio;
  new.title := btrim(new.title);
  new.details := nullif(btrim(coalesce(new.details, '')), '');
  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists workday_items_biu on public.workday_items;
create trigger workday_items_biu
  before insert or update on public.workday_items
  for each row execute function public.workday_items_biu();

create or replace function public.workday_sections_biu()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.studio_id <> old.studio_id then
    raise exception 'workday_other_studio' using errcode = '23514';
  end if;
  new.title := btrim(new.title);
  return new;
end;
$$;

drop trigger if exists workday_sections_biu on public.workday_sections;
create trigger workday_sections_biu
  before insert or update on public.workday_sections
  for each row execute function public.workday_sections_biu();

-- Отметка: клуб — клуб пункта, день — только сегодня, кто и когда — база.
-- security definer — прочитать имя отметившего из profiles.
create or replace function public.workday_checks_bi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select studio_id into new.studio_id from public.workday_items where id = new.item_id;
  if new.studio_id is null then
    raise exception 'workday_item_not_found' using errcode = '23503';
  end if;
  new.day := coalesce(new.day, public.workday_today());
  if new.day <> public.workday_today() then
    raise exception 'workday_not_today' using errcode = '23514';
  end if;
  new.checked_by := auth.uid();
  new.checked_at := now();
  new.checked_by_name := (select nullif(btrim(full_name), '') from public.profiles where id = auth.uid());
  return new;
end;
$$;

drop trigger if exists workday_checks_bi on public.workday_checks;
create trigger workday_checks_bi
  before insert on public.workday_checks
  for each row execute function public.workday_checks_bi();

-- 4) RLS -----------------------------------------------------------------------

alter table public.workday_sections enable row level security;
alter table public.workday_items enable row level security;
alter table public.workday_checks enable row level security;

grant select, insert, update, delete on public.workday_sections, public.workday_items
  to authenticated;
grant select, insert, delete on public.workday_checks to authenticated;
grant all on public.workday_sections, public.workday_items, public.workday_checks to service_role;

drop policy if exists "workday_sections staff read" on public.workday_sections;
create policy "workday_sections staff read" on public.workday_sections
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "workday_sections owner write" on public.workday_sections;
create policy "workday_sections owner write" on public.workday_sections
  for all to authenticated
  using (studio_id = any ((select public.auth_owner_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_owner_studio_ids())::uuid[]));

drop policy if exists "workday_items staff read" on public.workday_items;
create policy "workday_items staff read" on public.workday_items
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "workday_items owner write" on public.workday_items;
create policy "workday_items owner write" on public.workday_items
  for all to authenticated
  using (studio_id = any ((select public.auth_owner_studio_ids())::uuid[]))
  with check (studio_id = any ((select public.auth_owner_studio_ids())::uuid[]));

drop policy if exists "workday_checks staff read" on public.workday_checks;
create policy "workday_checks staff read" on public.workday_checks
  for select to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "workday_checks staff insert" on public.workday_checks;
create policy "workday_checks staff insert" on public.workday_checks
  for insert to authenticated
  with check (studio_id = any ((select public.auth_staff_studio_ids())::uuid[]));

drop policy if exists "workday_checks staff delete today" on public.workday_checks;
create policy "workday_checks staff delete today" on public.workday_checks
  for delete to authenticated
  using (studio_id = any ((select public.auth_staff_studio_ids())::uuid[])
         and day = (select public.workday_today()));

-- 5) RPC -----------------------------------------------------------------------

-- Новый порядок блоков (p_kind = 'section', все блоки клуба) или пунктов
-- блока (p_kind = 'item') одним запросом: sort_order — место в массиве.
-- security invoker: менять порядок может тот, кому RLS даёт правку.
create or replace function public.workday_reorder(p_kind text, p_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_groups integer;
begin
  if p_kind = 'section' then
    select count(distinct studio_id) into v_groups from public.workday_sections where id = any (p_ids);
    if v_groups > 1 then
      raise exception 'workday_other_studio' using errcode = '23514';
    end if;
    update public.workday_sections s
       set sort_order = o.pos
      from unnest(p_ids) with ordinality o(id, pos)
     where s.id = o.id and s.sort_order is distinct from o.pos::integer;
  elsif p_kind = 'item' then
    select count(distinct section_id) into v_groups from public.workday_items where id = any (p_ids);
    if v_groups > 1 then
      raise exception 'workday_other_section' using errcode = '23514';
    end if;
    update public.workday_items i
       set sort_order = o.pos
      from unnest(p_ids) with ordinality o(id, pos)
     where i.id = o.id and i.sort_order is distinct from o.pos::integer;
  else
    raise exception 'workday_bad_kind' using errcode = '22023';
  end if;
end;
$$;

-- «Скопировать из другого клуба»: блоки и пункты клуба p_to заменяются
-- копией p_from (отметки p_to уходят вместе с прежними пунктами). Читать
-- источник — сотрудник клуба p_from, писать — владелец p_to (RLS).
create or replace function public.workday_copy(p_from uuid, p_to uuid)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  s record;
  v_new uuid;
  v_count integer := 0;
  v_added integer;
begin
  if p_from = p_to then
    raise exception 'workday_same_studio' using errcode = '22023';
  end if;
  if not (p_to = any (public.auth_owner_studio_ids())) then
    raise exception 'workday_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workday_sections where studio_id = p_from) then
    raise exception 'workday_source_empty' using errcode = '22023';
  end if;
  delete from public.workday_sections where studio_id = p_to;
  for s in select * from public.workday_sections where studio_id = p_from order by sort_order, created_at loop
    insert into public.workday_sections (studio_id, title, sort_order)
    values (p_to, s.title, s.sort_order)
    returning id into v_new;
    insert into public.workday_items (studio_id, section_id, title, details, due_time, sort_order)
    select p_to, v_new, i.title, i.details, i.due_time, i.sort_order
      from public.workday_items i
     where i.section_id = s.id;
    get diagnostics v_added = row_count;
    v_count := v_count + v_added;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.workday_reorder(text, uuid[]) to authenticated;
grant execute on function public.workday_copy(uuid, uuid) to authenticated;

-- 6) Стартовый набор (таблица Lady Stretch «Рабочий день») ------------------------
-- Время владелец проставит в админке. Клиентские имена из примера отчёта в
-- таблице не переносим — только форма.

do $$
declare
  v_docs constant text := 'https://docs.google.com/document/d/159ewrnku_MAttFMWQaO1yR_nTFrCiXJxNEusZtYe-X8/edit';
  v_start_common constant text[] := array[
    'Проверить, чтобы в зоне обувницы не было пыли, песка. Подмести/пропылесосить, если необходимо',
    'Проверить в уборной наличие туалетной бумаги, бумажных салфеток, мыла',
    'Протереть зеркало над раковиной сухой тряпкой, если оно в разводах и каплях',
    'Проверить наличие воды в бутыле и стаканчиков для клиентов',
    'Протереть сильно видимую пыль на всех поверхностях'
  ];
  v_day constant text[] := array[
    'В течение рабочего дня работа с заявками и клиентами по графику',
    'Написать утренний отчет в чат Администраторы',
    'Ответить на все непрочитанные сообщения',
    'В инстаграме проверить новые подписки, всем отправить приветственное сообщение',
    'В обеденный перерыв админ тоже на связи! Все сообщения должны отрабатываться оперативно, мы не заставляем клиента ждать!',
    'На новую заявку максимальное время ответа — 30 минут',
    'Работаем в студии с пришедшими клиентами, если необходимо продлить абонемент. Если остается мало занятий в абонементе, уточняем, какие планы о продлении, выбрал ли он уже себе следующий абонемент или ему нужна помощь.',
    'Выборочно у клиентов спрашиваем о самочувствии, результатах. Клиенты должны понимать, что они важны, что вам на них не все равно, что вы не просто так там сидите',
    'В студии всегда должна быть дружелюбная и поддерживающая атмосфера',
    'В течение дня обязательно проверять порядок в уборной и раздевалке, наличие стаканов, салфеток, бумаги. Если скопились волосы, подмести, чистота должна быть не только перед первой тренировкой и после последней, а весь день и для каждой группы!',
    'После утренних тренировок подмести раздевалку, прикрыть все шкафчики, подготовить студию к вечерним занятиям'
  ];
  v_end constant text[] := array[
    'Подмести/пропылесосить, прибраться во всем помещении, если нужно',
    'В шкафчиках проверить, чтобы никто не оставил вещи, все шкафы прикрыть',
    'Выключить свет и неон, кондиционеры',
    'В уборной долить мыло, поставить новый рулон туалетной бумаги, доложить салфетки, если необходимо, подмести',
    'Скинуть отчет о продажах по форме в чат Администраторы',
    'Скинуть отчет об уборке в чат Уборка',
    'Написать в чат с тренерами занятия на завтрашний день',
    'Почистить пылесос, если пора',
    'Вынести мусор',
    'Оставить на следующий день другому администратору чистую студию, чтобы с утра он за вас ничего не убирал'
  ];
  st record;
  v_start text[];
  v_sec uuid;
  v_title text;
  v_pos integer;
  v_details text;
begin
  for st in
    select id, name,
           case when name ~* '(сабуртало|saburtalo)' then 'saburtalo' else 'vake' end as kind
      from public.studios
     where (name ~* '(сабуртало|saburtalo)' or name ~* '(ваке|vake)')
       and not exists (select 1 from public.workday_sections ws where ws.studio_id = studios.id)
  loop
    if st.kind = 'saburtalo' then
      v_start := array[
        'Включить свет и неоновый свет во всех помещениях, кондиционеры в зале и раздевалке (если необходимо)',
        'Включить Алису, музыка релакс, фоновая, что-то расслабляющее',
        'Открыть дверь в массажный кабинет, включить на айпаде плейлист, включить колонку',
        'В массажном кабинете проверить, чтобы в графине было достаточно воды и стаканы'
      ] || v_start_common || array[
        'Проверить, чтобы в раздевалке дезодорант и мист для тела были в достаточном кол-ве, проверить упаковку влажных салфеток, всего должно хватать для рабочего дня',
        'Проверить, чтобы на полу не валялись волосы! Подмести/пропылесосить, если необходимо'
      ];
    else
      v_start := array[
        'Включить свет и неоновый свет во всех помещениях, кондиционеры в зале и раздевалке (если необходимо)',
        'Включить Алису, музыка релакс, фоновая, что-то расслабляющее',
        'В раздевалке ковры должны быть чистыми, без ниток и волос',
        'Протереть полки под зеркалами, если пора'
      ] || v_start_common || array[
        'Проверить, чтобы в раздевалке дезодорант и салфетки были в достаточном кол-ве, всего должно хватать для рабочего дня',
        'Проверить, чтобы на полу не валялись волосы! Подмести/пропылесосить, если необходимо'
      ];
    end if;

    insert into public.workday_sections (studio_id, title, sort_order)
    values (st.id, 'Начало рабочего дня', 1) returning id into v_sec;
    v_pos := 0;
    foreach v_title in array v_start loop
      v_pos := v_pos + 1;
      insert into public.workday_items (studio_id, section_id, title, sort_order)
      values (st.id, v_sec, v_title, v_pos);
    end loop;

    insert into public.workday_sections (studio_id, title, sort_order)
    values (st.id, 'Рабочий день', 2) returning id into v_sec;
    v_pos := 0;
    foreach v_title in array v_day loop
      v_pos := v_pos + 1;
      v_details := case v_pos
        when 1 then format(E'Материалы:\n- [График обработки заявок](%1$s)\n- [Алгоритм записи на пробное](%1$s)\n- [Алгоритм продажи абонемента](%1$s)\n- [Правила обработки задач](%1$s)', v_docs)
        when 2 then format(E'Пример:\n\n%s 25.07\n12:00 Фамилия Имя — разово\nФамилия Имя — пробное\nФамилия Имя — продление\n17:00 Фамилия Имя — пробное',
                           case st.kind when 'saburtalo' then 'Сабуртало' else 'Ваке' end)
      end;
      insert into public.workday_items (studio_id, section_id, title, details, sort_order)
      values (st.id, v_sec, v_title, v_details, v_pos);
    end loop;

    insert into public.workday_sections (studio_id, title, sort_order)
    values (st.id, 'Конец рабочего дня', 3) returning id into v_sec;
    v_pos := 0;
    foreach v_title in array v_end loop
      v_pos := v_pos + 1;
      insert into public.workday_items (studio_id, section_id, title, sort_order)
      values (st.id, v_sec, v_title, v_pos);
    end loop;
  end loop;
end;
$$;

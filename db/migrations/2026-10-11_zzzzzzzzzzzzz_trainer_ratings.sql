-- ============================================================================
-- Рейтинг тренеров и чаевые (приложение пакетных студий, решение владельца
-- 2026-10-11):
--
-- 1. Оценки клиентов: trainer_reviews — одна оценка (1–5 звёзд) от учётной
--    записи на тренера, клиент ставит её в карточке тренера («Студия» →
--    «Тренеры») и может изменить. Оценить можно тренера, которого клиент
--    видит в приложении: своей студии или студии того же формата
--    (client_can_browse_studio). Свои оценки клиент читает, чужие — нет;
--    сотрудник с разделом «Сотрудники» видит все.
-- 2. Рейтинг из прежнего сервиса: trainers.rating_base_avg/rating_base_count
--    — оценка и число отзывов до приложения, входят в рейтинг как уже
--    оставленные отзывы. Заполнены ниже по фамилии (что не нашлось — NOTICE
--    в логе мигратора; поправить в админке: «Сотрудники» → «Изменить»).
-- 3. Итог: trainers.rating_avg (до сотых) и rating_count — считает триггер
--    (прежние + оценки из приложения), руками не пишутся: любое изменение
--    строки тренера пересчитывает их заново. Клиенты читают их вместе с
--    тренером (прежние политики trainers), админка — колонка «Рейтинг».
-- 4. Чаевые: trainers.tip_url — ссылка на внешний сервис чаевых, кнопка
--    «Поблагодарить тренера» в карточке тренера; задаётся в «Сотрудниках».
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

-- 1. Колонки тренера -----------------------------------------------------------

alter table public.trainers add column if not exists rating_base_avg numeric(3,2);
alter table public.trainers add column if not exists rating_base_count integer not null default 0;
alter table public.trainers add column if not exists rating_avg numeric(3,2);
alter table public.trainers add column if not exists rating_count integer not null default 0;
alter table public.trainers add column if not exists tip_url text;

alter table public.trainers drop constraint if exists trainers_rating_base_check;
alter table public.trainers add constraint trainers_rating_base_check check (
  rating_base_count >= 0
  and (rating_base_avg is null or rating_base_avg between 1 and 5)
  and (rating_base_count = 0 or rating_base_avg is not null)
);

comment on column public.trainers.rating_base_avg is
  'Средняя оценка из прежнего сервиса (до приложения), 1–5.';
comment on column public.trainers.rating_base_count is
  'Число отзывов в прежнем сервисе — входят в рейтинг вместе с оценками из приложения.';
comment on column public.trainers.rating_avg is
  'Рейтинг тренера до сотых: прежние отзывы + trainer_reviews. Считает триггер trainers_rating_calc.';
comment on column public.trainers.rating_count is
  'Число отзывов в рейтинге (прежние + trainer_reviews). Считает триггер trainers_rating_calc.';
comment on column public.trainers.tip_url is
  'Ссылка на внешний сервис чаевых тренеру (кнопка «Поблагодарить тренера» в приложении).';

-- 2. Оценки клиентов -----------------------------------------------------------

create table if not exists public.trainer_reviews (
  trainer_id uuid not null references public.trainers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (trainer_id, user_id)
);

create index if not exists trainer_reviews_user_idx on public.trainer_reviews (user_id);

grant select, insert, update on public.trainer_reviews to authenticated;
grant all on public.trainer_reviews to service_role;

alter table public.trainer_reviews enable row level security;

-- Тренер, которого вызывающий видит в приложении.
create or replace function public.client_can_rate_trainer(_trainer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.trainer_studios ts
     where ts.trainer_id = _trainer_id
       and (
         ts.studio_id = public.current_studio_id(auth.uid())
         or public.client_can_browse_studio(ts.studio_id)
       )
  )
$$;

revoke all on function public.client_can_rate_trainer(uuid) from public;
grant execute on function public.client_can_rate_trainer(uuid) to authenticated;

drop policy if exists "trainer_reviews own select" on public.trainer_reviews;
create policy "trainer_reviews own select" on public.trainer_reviews
  for select to authenticated
  using (user_id = auth.uid() or public.has_admin_section(auth.uid(), 'staff'));

drop policy if exists "trainer_reviews own insert" on public.trainer_reviews;
create policy "trainer_reviews own insert" on public.trainer_reviews
  for insert to authenticated
  with check (user_id = auth.uid() and public.client_can_rate_trainer(trainer_id));

drop policy if exists "trainer_reviews own update" on public.trainer_reviews;
create policy "trainer_reviews own update" on public.trainer_reviews
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.client_can_rate_trainer(trainer_id));

-- Дата правки и неизменные ключи: оценку можно поменять, но не перенести на
-- другого тренера или другую учётную запись.
create or replace function public.trainer_reviews_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.trainer_id := old.trainer_id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trainer_reviews_touch on public.trainer_reviews;
create trigger trainer_reviews_touch
  before insert or update on public.trainer_reviews
  for each row execute function public.trainer_reviews_touch();

-- 3. Итоговый рейтинг ------------------------------------------------------------

-- Пересчёт при любой записи строки тренера: прежние отзывы + оценки клиентов.
-- security definer: оценки других клиентов вызывающему не видны.
create or replace function public.trainers_rating_calc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _sum numeric;
  _cnt integer;
begin
  select coalesce(sum(r.rating), 0), count(*)
    into _sum, _cnt
    from public.trainer_reviews r
   where r.trainer_id = new.id;

  if coalesce(new.rating_base_count, 0) = 0 then
    new.rating_base_count := 0;
    new.rating_base_avg := null;
  end if;

  _sum := _sum + coalesce(new.rating_base_avg, 0) * new.rating_base_count;
  _cnt := _cnt + new.rating_base_count;

  new.rating_count := _cnt;
  new.rating_avg := case when _cnt > 0 then round(_sum / _cnt, 2) end;
  return new;
end;
$$;

drop trigger if exists trainers_rating_calc on public.trainers;
create trigger trainers_rating_calc
  before insert or update on public.trainers
  for each row execute function public.trainers_rating_calc();

-- Оценка изменилась — пересчитать тренера (его триггер посчитает заново).
-- security definer: клиент не может писать в trainers.
create or replace function public.trainer_reviews_refresh_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.trainers
     set rating_count = rating_count
   where id = coalesce(new.trainer_id, old.trainer_id);
  return null;
end;
$$;

drop trigger if exists trainer_reviews_refresh_rating on public.trainer_reviews;
create trigger trainer_reviews_refresh_rating
  after insert or update or delete on public.trainer_reviews
  for each row execute function public.trainer_reviews_refresh_rating();

-- 4. Рейтинги из прежнего сервиса (скриншот владельца 2026-10-11) -------------

-- Тренер ищется по фамилии латиницей или кириллицей среди слов имени;
-- заполняется, только если нашёлся ровно один и прежнего рейтинга у него ещё
-- нет (повторный прогон не затирает исправленное в админке).
do $$
declare
  _r record;
  _ids uuid[];
begin
  for _r in
    select * from (values
      (array['fileva', 'филева'],                       4.99::numeric, 56),
      (array['korzukhina', 'корзухина'],                4.98::numeric, 7),
      (array['nadergulova', 'надергулова'],             5.00::numeric, 1),
      (array['olkhovska', 'olkhovskaya', 'ольховская', 'ольховска'], 4.98::numeric, 16),
      (array['polevshchikova', 'полевщикова'],          4.85::numeric, 2),
      (array['romashkina', 'ромашкина'],                5.00::numeric, 4),
      (array['zosimova', 'зосимова'],                   4.98::numeric, 66)
    ) as v(names, avg, cnt)
  loop
    select array_agg(t.id) into _ids
      from public.trainers t
     where regexp_split_to_array(lower(replace(btrim(t.full_name), 'ё', 'е')), '\s+') && _r.names;

    if coalesce(array_length(_ids, 1), 0) = 1 then
      update public.trainers
         set rating_base_avg = _r.avg,
             rating_base_count = _r.cnt
       where id = _ids[1]
         and rating_base_count = 0;
    else
      raise notice 'Рейтинг «%»: найдено тренеров — % (нужен ровно один), задайте в «Сотрудниках»',
        _r.names[1], coalesce(array_length(_ids, 1), 0);
    end if;
  end loop;
end;
$$;

-- Пересчитать итог всем (новые колонки только что добавлены).
update public.trainers set rating_count = rating_count;

notify pgrst, 'reload schema';

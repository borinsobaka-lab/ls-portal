-- ============================================================================
-- Карточка клиента для уже существующих пользователей. Идемпотентно.
-- Запускать после db/client_app_fixes.sql.
--
-- Почему нужно: handle_new_user срабатывает только на INSERT в auth.users,
-- то есть при создании НОВОГО пользователя. Все, кто зарегистрировался раньше
-- (а это все тестовые аккаунты), остались без строки в clients. Повторная
-- «регистрация» с той же почтой не помогает: Supabase видит существующего
-- пользователя и просто присылает код на вход — нового auth.users нет,
-- триггер не срабатывает. Такой клиент видит «Профиль клиента не привязан к
-- студии» и не может записаться на тренировку.
--
-- Здесь: разовый бэкфилл + функция самолечения, чтобы ситуация не повторилась
-- ни при сбое триггера, ни у сотрудника, который зашёл в клиентское
-- приложение как обычный посетитель.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Функция: гарантировать карточку клиента для текущего пользователя.
--    Клиентское приложение вызывает её, когда карточки не нашлось.
--    Сначала пытаемся привязать заведённую администратором (по совпадению
--    почты), иначе заводим новую в единственной студии.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_client_profile()
returns table (id uuid, studio_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_meta jsonb;
  v_studio uuid;
  v_client public.clients%rowtype;
  _first text;
  _last text;
  _full text;
  _phone text;
begin
  if v_user is null then
    raise exception 'unauthorized';
  end if;

  -- Уже есть карточка — просто возвращаем её.
  select * into v_client from public.clients c where c.user_id = v_user limit 1;
  if found then
    id := v_client.id; studio_id := v_client.studio_id; return next; return;
  end if;

  select u.email, u.raw_user_meta_data into v_email, v_meta
    from auth.users u where u.id = v_user;

  _first := nullif(trim(coalesce(v_meta->>'first_name', '')), '');
  _last  := nullif(trim(coalesce(v_meta->>'last_name', '')), '');
  _phone := nullif(trim(coalesce(v_meta->>'phone', '')), '');
  _full  := nullif(trim(coalesce(v_meta->>'full_name', concat_ws(' ', _last, _first))), '');

  -- Студия: пока она одна, поэтому берём её же. Когда студий станет несколько,
  -- сюда придёт выбор студии при регистрации (raw_user_meta_data.studio_id).
  v_studio := nullif(v_meta->>'studio_id', '')::uuid;
  if v_studio is null then
    select p.studio_id into v_studio from public.profiles p where p.id = v_user;
  end if;
  if v_studio is null then
    select s.id into v_studio from public.studios s order by s.created_at asc limit 1;
  end if;
  if v_studio is null then
    raise exception 'no studio configured';
  end if;

  -- Карточка, заведённая администратором на ту же почту, но ещё не привязанная.
  update public.clients c
     set user_id = v_user,
         phone = coalesce(c.phone, _phone),
         first_name = coalesce(c.first_name, _first),
         last_name = coalesce(c.last_name, _last)
   where c.user_id is null
     and c.email is not null
     and v_email is not null
     and lower(c.email) = lower(v_email)
     and c.studio_id = v_studio
   returning * into v_client;

  if not found then
    insert into public.clients (
      studio_id, user_id, full_name, first_name, last_name, phone, email, registration_date
    ) values (
      v_studio, v_user, coalesce(_full, v_email, ''), _first, _last, _phone, v_email, current_date
    )
    returning * into v_client;
  end if;

  -- profiles должен смотреть на ту же студию: от него зависит RLS расписания.
  update public.profiles p
     set studio_id = v_studio
   where p.id = v_user and p.studio_id is distinct from v_studio;

  id := v_client.id; studio_id := v_client.studio_id; return next;
end;
$$;

revoke all on function public.ensure_client_profile() from public;
grant execute on function public.ensure_client_profile() to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Разовый бэкфилл для тех, кто уже зарегистрирован.
--    Сотрудников намеренно пропускаем: иначе список клиентов в админке
--    засорится тренерами и администраторами, которые приложением не
--    пользуются. Сотрудник, открывший клиентское приложение, получит карточку
--    через ensure_client_profile() выше.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_studio uuid;
  _first text; _last text; _full text; _phone text; _linked int;
begin
  select id into v_studio from public.studios order by created_at asc limit 1;
  if v_studio is null then
    raise notice 'Студий нет — бэкфилл пропущен';
    return;
  end if;

  for r in
    select u.id, u.email, u.raw_user_meta_data as meta
      from auth.users u
     where not exists (select 1 from public.clients c where c.user_id = u.id)
       and not exists (
         select 1 from public.user_roles ur
          where ur.user_id = u.id and ur.role in ('owner','admin','trainer')
       )
  loop
    _first := nullif(trim(coalesce(r.meta->>'first_name', '')), '');
    _last  := nullif(trim(coalesce(r.meta->>'last_name', '')), '');
    _phone := nullif(trim(coalesce(r.meta->>'phone', '')), '');
    _full  := nullif(trim(coalesce(r.meta->>'full_name', concat_ws(' ', _last, _first))), '');

    update public.clients c
       set user_id = r.id,
           phone = coalesce(c.phone, _phone),
           first_name = coalesce(c.first_name, _first),
           last_name = coalesce(c.last_name, _last)
     where c.user_id is null
       and c.email is not null
       and r.email is not null
       and lower(c.email) = lower(r.email)
       and c.studio_id = v_studio;
    get diagnostics _linked = row_count;

    if _linked = 0 then
      insert into public.clients (
        studio_id, user_id, full_name, first_name, last_name, phone, email, registration_date
      ) values (
        v_studio, r.id, coalesce(_full, r.email, ''), _first, _last, _phone, r.email, current_date
      );
    end if;
  end loop;
end $$;

-- Профили выравниваем по карточкам (RLS расписания смотрит на profiles).
update public.profiles p
   set studio_id = c.studio_id
  from public.clients c
 where c.user_id = p.id
   and c.studio_id is not null
   and p.studio_id is distinct from c.studio_id;

notify pgrst, 'reload schema';

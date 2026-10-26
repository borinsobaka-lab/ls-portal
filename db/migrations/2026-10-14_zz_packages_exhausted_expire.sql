-- ============================================================================
-- Пакетные клубы: абонемент без тренировок — «Закончился» (решение владельца
-- 2026-10-14). Раньше отхоженный абонемент (и пробное) оставался active с
-- нулевым остатком, пока не продадут продление, — клиент видел его в
-- приложении в «Абонементах», а в «Клиентах» он считался членом клуба.
--
-- packages_settle (тело — как в 2026-10-11_zzzzzzzz_review_fixes.sql, кроме):
--  * действующий абонемент без остатка — expired и без ждущего продления.
--    Без остатка: групповой — visits_left = 0 и не осталось подарочных
--    персональных (personal_left), пакет персональных — personal_left = 0;
--    безлимит (visits_left null) не кончается;
--  * текущего нет, а на отхоженный абонемент вернули тренировку (сняли
--    «Посетил», удалили запись или отменили занятие) и срок не вышел — он
--    снова текущий, раньше ждущего продления. Тот же признак, что у
--    возврата на абонемент при начатом продлении: expired, срок начат, есть
--    остаток, срок не вышел (expired по сроку сюда не попадает, замена —
--    replaced, возврат денег — refunded).
-- Разово — то же для уже отхоженных абонементов.
--
-- Идемпотентно. Выполняет мигратор при старте админки (db/migrate.ts).
-- ============================================================================

create or replace function public.packages_settle(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tbilisi')::date;
  v_balance text;
  v_live public.client_memberships%rowtype;
  v_old public.client_memberships%rowtype;
  v_has_live boolean;
begin
  if p_client_id is null or not exists (
    select 1 from public.clients c
      join public.studios st on st.id = c.studio_id and st.format = 'packages'
     where c.id = p_client_id
  ) then
    return;
  end if;
  -- Две отметки одного клиента одновременно не активируют два продления
  -- (второе падало на client_memberships_one_live_per_balance).
  perform 1 from public.clients where id = p_client_id for update;

  foreach v_balance in array array['group', 'personal'] loop
    select * into v_live from public.client_memberships
     where client_id = p_client_id and balance_kind = v_balance
       and status in ('active', 'frozen')
     limit 1;
    v_has_live := found;

    -- Вернули тренировку на исчерпанный прежний абонемент, а продление ещё
    -- не начато — прежний снова текущий, продление снова ждёт.
    if v_has_live and v_live.status = 'active' and v_live.starts_on_first_visit
       and v_live.started_at is null then
      select * into v_old from public.client_memberships
       where client_id = p_client_id and balance_kind = v_balance
         and status = 'expired'
         and id <> v_live.id
         and started_at is not null
         and (case when v_balance = 'personal' then personal_left > 0
                   else visits_left is null or visits_left > 0 end)
         and (ends_at is null or ends_at >= v_today)
       order by created_at desc
       limit 1;
      if found then
        update public.client_memberships set status = 'pending' where id = v_live.id;
        update public.client_memberships set status = 'active' where id = v_old.id;
        v_live := v_old;
        v_live.status := 'active';
      end if;
    end if;

    -- Текущий кончился (основной остаток или срок), а продление ждёт.
    if v_has_live and v_live.status = 'active'
       and ((v_balance = 'personal' and v_live.personal_left <= 0)
            or (v_balance = 'group' and v_live.visits_left is not null and v_live.visits_left <= 0)
            or (v_live.ends_at is not null and v_live.ends_at < v_today))
       and exists (
         select 1 from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
       ) then
      update public.client_memberships set status = 'expired' where id = v_live.id;
      v_has_live := false;
    end if;

    -- Текущий отхожен целиком, продления нет — «Закончился».
    if v_has_live and v_live.status = 'active'
       and (case when v_balance = 'personal' then coalesce(v_live.personal_left, 0) <= 0
                 else v_live.visits_left is not null and v_live.visits_left <= 0
                      and coalesce(v_live.personal_left, 0) <= 0 end) then
      update public.client_memberships set status = 'expired' where id = v_live.id;
      v_has_live := false;
    end if;

    -- Текущего нет, а на отхоженный вернули тренировку — он снова текущий.
    if not v_has_live then
      select * into v_old from public.client_memberships
       where client_id = p_client_id and balance_kind = v_balance
         and status = 'expired'
         and started_at is not null
         and (case when v_balance = 'personal' then personal_left > 0
                   else visits_left is null or visits_left > 0 end)
         and (ends_at is null or ends_at >= v_today)
       order by created_at desc
       limit 1;
      if found then
        update public.client_memberships set status = 'active' where id = v_old.id;
        v_has_live := true;
      end if;
    end if;

    -- Текущего нет — ждущий (самый ранний по продаже) становится текущим.
    if not v_has_live then
      update public.client_memberships
         set status = 'active'
       where id = (
         select id from public.client_memberships
          where client_id = p_client_id and balance_kind = v_balance and status = 'pending'
          order by created_at
          limit 1
       );
    end if;
  end loop;
end;
$$;

revoke all on function public.packages_settle(uuid) from public, anon, authenticated;

-- Разово: уже отхоженные абонементы пакетных клубов.
do $$
declare
  v_client uuid;
begin
  for v_client in
    select distinct cm.client_id
      from public.client_memberships cm
      join public.clients c on c.id = cm.client_id
      join public.studios st on st.id = c.studio_id and st.format = 'packages'
     where cm.status = 'active'
       and (case when cm.balance_kind = 'personal' then coalesce(cm.personal_left, 0) <= 0
                 else cm.visits_left is not null and cm.visits_left <= 0
                      and coalesce(cm.personal_left, 0) <= 0 end)
  loop
    perform public.packages_settle(v_client);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

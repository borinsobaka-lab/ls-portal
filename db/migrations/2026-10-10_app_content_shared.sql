-- ============================================================================
-- Мобильное приложение — общее для всех студий (решение владельца 2026-10-10).
--
-- Новости, услуги и пуш-уведомления больше не принадлежат студии: раздел
-- «Мобильное приложение» в админке — в рейке, над студиями, и показывает все
-- записи. Новые записи — без studio_id; старые сохраняют свой studio_id, но он
-- нигде не используется (клиентское приложение показывает всё).
-- club_settings и так общий синглтон.
--
-- Правка — любой сотрудник (is_staff), чтение новостей и услуг — как было,
-- публичное. Идемпотентно. Выполняет мигратор при старте админки.
-- ============================================================================

-- Таблицы могли и не дойти до живой базы — пропускаем отсутствующие.
do $$
declare
  t text;
begin
  foreach t in array array['news', 'services', 'push_notifications'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'Таблицы % нет — пропускаю', t;
      continue;
    end if;

    execute format('alter table public.%I alter column studio_id drop not null', t);

    -- Прежние политики правки — по студии записи; без студии они не пускают никого.
    execute format('drop policy if exists %I on public.%I', t || ' studio write', t);
    execute format('drop policy if exists %I on public.%I', 'push studio write', t);
    execute format('drop policy if exists %I on public.%I', 'push studio read', t);

    execute format('drop policy if exists %I on public.%I', t || ' staff write', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (public.is_staff(auth.uid())) with check (public.is_staff(auth.uid()))',
      t || ' staff write', t);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

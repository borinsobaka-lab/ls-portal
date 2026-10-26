-- Онбординг приложения пакетных студий (pack.base40.fit), решение владельца
-- 2026-10-11. Анкета та же — member_profiles, — но вопросы другие:
--   * цели: «Стать гибче» / «Снять напряжение и стресс» / «Подтянуть фигуру» /
--     «Другое» с текстом — новые значения fitness_goal и колонка goal_other;
--   * вместо года рождения — дата: birth_date (birth_year пишется рядом —
--     его читают статистика и прежняя «Анкета» админки);
--   * пол не спрашивается: в пакетных студиях все клиентки, приложение
--     ставит 'female' само.
-- Подписочное приложение ничего из этого не пишет.

do $$
begin
  -- member_profiles создан вне мигратора (db/member_profiles.sql); на чистой
  -- базе без него пропускаем, как 2026-10-11_app_install_settings.sql.
  if to_regclass('public.member_profiles') is not null then
    alter table public.member_profiles add column if not exists goal_other text;
    alter table public.member_profiles add column if not exists birth_date date;

    alter table public.member_profiles drop constraint if exists member_profiles_goal_other_len;
    alter table public.member_profiles add constraint member_profiles_goal_other_len
      check (goal_other is null or char_length(goal_other) <= 500);
  end if;

  -- primary_goal — enum fitness_goal (db/member_profiles.sql). Новые значения
  -- в этой же транзакции не используются — так add value допустим (PG 12+).
  if to_regtype('public.fitness_goal') is not null then
    alter type public.fitness_goal add value if not exists 'flexibility';
    alter type public.fitness_goal add value if not exists 'stress_relief';
    alter type public.fitness_goal add value if not exists 'body_shape';
    alter type public.fitness_goal add value if not exists 'other';
  end if;
end;
$$;

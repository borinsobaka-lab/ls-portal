-- Привязка обратной связи и NPS к студии (подготовка к мультистудийности).
-- Выполнять в Supabase SQL Editor целиком, идемпотентно.
--
-- Контекст: feedback и nps_responses были глобальными — с открытием второй
-- студии отзывы всех точек смешивались бы в один список. Клиентское приложение
-- в эти таблицы НЕ пишет (проверено: обратная связь там — внешняя ссылка из
-- club_settings.feedback_url), поэтому миграция затрагивает только админку.
--
-- Стратегия совместимости:
--   1) колонка добавляется как nullable — существующие строки валидны;
--   2) если студия в базе ровно одна, старые строки привязываются к ней;
--   3) при нескольких студиях старые строки остаются с studio_id is null —
--      админка показывает их в каждой студии (фильтр в коде учитывает null),
--      чтобы ни один отзыв не пропал из виду.

alter table public.feedback
  add column if not exists studio_id uuid references public.studios(id) on delete set null;

alter table public.nps_responses
  add column if not exists studio_id uuid references public.studios(id) on delete set null;

create index if not exists feedback_studio_status_idx
  on public.feedback (studio_id, status, created_at desc);

create index if not exists nps_responses_studio_created_idx
  on public.nps_responses (studio_id, created_at desc);

-- Бэкфилл только в однозначной ситуации (одна студия).
do $$
declare
  _cnt int;
  _sid uuid;
begin
  select count(*) into _cnt from public.studios;
  if _cnt = 1 then
    select id into _sid from public.studios;
    update public.feedback set studio_id = _sid where studio_id is null;
    update public.nps_responses set studio_id = _sid where studio_id is null;
  end if;
end $$;

notify pgrst, 'reload schema';

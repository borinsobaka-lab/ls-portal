# Бронирование тренировок — инструкция для мобильного приложения

## Что я сделал на бэкенде и портале

### Схема (см. `db/bookings.sql`)

- `public.workouts.capacity int` — вместимость по умолчанию для каждой тренировки (шаблон).
- `public.schedule_entries.capacity int` — необязательный override на конкретное занятие. Если `null` — берётся из `workouts.capacity`.
- `public.schedule_entries.booked_count int default 0` — счётчик записавшихся, поддерживается RPC.
- `public.schedule_bookings` — записи пользователей на конкретное занятие (`entry_id`, `user_id`, `status`, уникальная пара `entry_id+user_id`).
- CHECK-констрейнт: `booked_count <= capacity` (когда capacity задан на занятии).

### RPC (только серверная логика, никакого овербукинга)

- `book_schedule_entry(p_entry_id uuid) → jsonb` — атомарная запись:
  1. `SELECT … FOR UPDATE` строки `schedule_entries`.
  2. Проверка: занятие не в прошлом, есть активный `memberships.status = 'active'`, нет уже активной записи, `booked_count < capacity`.
  3. Вставка/реактивация строки в `schedule_bookings` + `booked_count += 1` — в одной транзакции.
  4. Возврат: `{ ok, booking_id, booked_count, capacity }` или `{ ok: false, reason }`.
- `cancel_schedule_booking(p_entry_id uuid) → jsonb` — отмена своей записи + декремент счётчика, тоже в транзакции.

Возможные `reason`: `unauthorized | not_found | past | no_membership | already_booked | full | not_booked`.

### Портал

- В разделе **Тренировки** добавлено поле «Вместимость (чел.)» и колонка в таблице.
- В **Расписании** в правом верхнем углу карточки занятия показывается `записалось / всего`, цвет меняется когда мест ≤ 5 или зал заполнен.

## Что нужно сделать в Supabase

Выполнить в SQL Editor по очереди (если ещё не выполнял предыдущие):

```
db/schema.sql            -- если не запускал ранее
db/workouts.sql          -- если не запускал ранее
db/schedule.sql          -- если не запускал ранее
db/bookings.sql          -- ← новый файл из этой задачи
```

Скрипт идемпотентен, можно запускать повторно.

## Интеграция в мобильное приложение

### 1. Список занятий с местами

Тяни расписание как обычно (`schedule_entries`), но добавь джойн на `workouts` для фолбэка по capacity:

```ts
const { data } = await supabase
  .from("schedule_entries")
  .select(
    `
    id, starts_at, ends_at, booked_count, capacity,
    workout:workouts ( id, name, capacity, photo_url, type ),
    schedule_entry_trainers ( trainer:trainers ( id, full_name, photo_url ) )
  `,
  )
  .gte("starts_at", new Date().toISOString())
  .order("starts_at");

const effectiveCapacity = (e) => e.capacity ?? e.workout?.capacity ?? 0;
const seatsLeft = (e) => Math.max(0, effectiveCapacity(e) - e.booked_count);
```

Чтобы знать, записан ли текущий пользователь на занятие — запроси свои активные бронирования:

```ts
const { data: myBookings } = await supabase
  .from("schedule_bookings")
  .select("entry_id, status")
  .eq("user_id", userId)
  .eq("status", "booked");

const myEntryIds = new Set(myBookings?.map((b) => b.entry_id) ?? []);
```

### 2. Кнопка «+ Записаться»

```ts
const { data, error } = await supabase.rpc("book_schedule_entry", {
  p_entry_id: entryId,
});
if (error) {
  /* сеть/permission */ return;
}
if (!data.ok) {
  switch (data.reason) {
    case "full":
      showToast("Мест больше нет");
      break;
    case "no_membership":
      showToast("Нужен активный абонемент");
      break;
    case "already_booked":
      showToast("Вы уже записаны");
      break;
    case "past":
      showToast("Занятие уже началось");
      break;
    default:
      showToast("Не удалось записаться");
  }
  return;
}
// data.booked_count и data.capacity — актуальные значения, можно обновить UI локально
```

### 3. Отмена записи

```ts
const { data } = await supabase.rpc("cancel_schedule_booking", {
  p_entry_id: entryId,
});
```

### 4. Индикатор «Мало мест»

```ts
const left = seatsLeft(entry);
const label =
  left === 0
    ? "Мест нет"
    : left <= 5
      ? `Осталось ${left} мест`
      : `${entry.booked_count} / ${effectiveCapacity(entry)}`;
```

### 5. Realtime (опционально)

Чтобы счётчик обновлялся у всех в реальном времени, подпишись на `schedule_entries`:

```ts
supabase
  .channel("schedule_entries")
  .on(
    "postgres_changes",
    { event: "UPDATE", schema: "public", table: "schedule_entries" },
    (payload) => updateLocalEntry(payload.new),
  )
  .subscribe();
```

## Важно

- Никаких проверок `booked_count < capacity` на клиенте — клиент только отображает результат RPC. Овербукинг исключён транзакцией + CHECK-констрейнтом.
- Прямой `insert into schedule_bookings` от обычного пользователя запрещён RLS — только тренеры и RPC.

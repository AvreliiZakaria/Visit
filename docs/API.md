# API «Вердикта»

База: `/api`. Сессия живёт в httpOnly-куке `verdict_session`, поэтому запросы
из браузера идут с `credentials: 'same-origin'`. Ошибки всегда в одном формате:

```json
{ "error": "not_listened", "message": "Голос откроется, когда прослушаешь обе стороны на 80%." }
```

---

## Служебное

### `GET /api/health`
Состояние сервера и действующие правила суда. Клиент берёт отсюда пороги,
чтобы показывать их пользователю, но решает всё равно сервер.

---

## Аккаунты

| Метод | Что делает |
|---|---|
| `POST /api/auth/register` | `{ email, password, ageConfirmed }`. Пароль от 8 символов, возраст 17+ обязателен. Ник выдаётся анонимный |
| `POST /api/auth/login` | `{ email, password }` |
| `POST /api/auth/logout` | Гасит сессию |
| `GET /api/auth/me` | Профиль, счёт побед и поражений, активные бейджи |
| `DELETE /api/auth/me` | Удаление аккаунта и всех данных, необратимо |

---

## Споры

### `POST /api/disputes`
`{ topic, consentContent }`. Тема от 8 до 90 символов. Возвращает дело
и `inviteUrl` для второй стороны.

### `POST /api/disputes/:id/sides`
`multipart/form-data`: поле `audio` с файлом, поле `durationMs`.
Принимаются webm, ogg, mp4, mpeg, wav, aac. Запись короче 10 секунд отклоняется,
перезапись после отправки запрещена. Ответ приходит сразу, распознавание
и модерация идут в фоне.

### `GET /api/disputes/invite/:token`
Публичный предпросмотр приглашения: тема, срок, записана ли первая сторона.

### `POST /api/disputes/invite/:token/accept`
Закрепляет вошедшего как сторону Б.

### `POST /api/disputes/:id/remind`
Напоминание оппоненту. Не больше двух на дело.

### `POST /api/disputes/:id/publish-one-sided`
Публикация без второй стороны. Доступна только после истечения срока на ответ,
дело получает видимую пометку.

### `GET /api/disputes/mine`
Мои дела: созданные, где я вторая сторона, где у меня есть запись.

### `GET /api/disputes/:id`
Дело целиком. Незакрытое дело видят только стороны и присяжные, которым его выдали.
Блок `verdict` появляется только после вынесения: до этого процентов нет ни для кого.

### `GET /api/disputes/:id/stream`
Server-Sent Events для сторон дела. События: `quorum`, `status`, `tier`,
`verdict`, `expired`, `abandoned`, `opponent_joined`.

### `GET /api/disputes/:id/audio/:label`
Запись стороны `a` или `b`. Доступна сторонам дела и присяжным с выданным делом.

---

## Жюри

### `GET /api/jury/next`
Выдаёт одно дело и фиксирует время выдачи. Не выдаёт свои дела, уже отсуженные
и те, что выдавались раньше. Срочные дела идут первыми. Порядок сторон
перемешан детерминированно от пары «дело плюс присяжный».

### `POST /api/jury/:disputeId/vote`
```json
{ "side": "a", "listenedA": 0.94, "listenedB": 0.88, "deviceId": "uuid" }
```
Проверки на сервере:

| Код ошибки | Причина |
|---|---|
| `too_fast` | Прошло меньше `MIN_SECONDS_BEFORE_VOTE` с выдачи дела |
| `not_listened` | Прослушано меньше `MIN_LISTEN_RATIO` любой из сторон |
| `impossible_listen` | Заявленное прослушивание не укладывается в прошедшее время |
| `already_voted` | Голос от этого пользователя в деле уже есть |
| `device_voted` | С этого устройства в деле уже голосовали |
| `party` | Свои дела не судят |
| `not_assigned` | Дело этому присяжному не выдавали |

Ответ не содержит ни счёта, ни процентов.

### `POST /api/jury/:disputeId/comment`
Только после голоса. До 400 символов, проходит ту же проверку на личные данные и угрозы.

### `POST /api/jury/comments/:commentId/upvote`
Один апвоут от пользователя.

### `GET /api/jury/:disputeId/comments`
Пустой массив, пока нет вердикта: до него комментарии влияли бы на голоса.

---

## Деньги

### `GET /api/payments/catalog`
Тарифы и режим работы: `sandbox` или `stripe`.

### `POST /api/payments/checkout`
`{ product, disputeId }`, где product это `urgent`, `wide` или `sub`.
Возможные ответы: `paid` в песочнице, `redirect` с адресом Stripe Checkout,
`paid_with_credit` при списании накопленного возврата,
`granted_by_subscription` если срочность уже входит в подписку.

### `POST /api/payments/webhook`
Вебхук Stripe. Единственное место, где выдаются права на покупку.
Подпись проверяется, если задан `STRIPE_WEBHOOK_SECRET`.

### `GET /api/payments/mine`
История покупок и остаток внутреннего кредита.

---

## Модерация

| Метод | Кто может |
|---|---|
| `POST /api/moderation/reports` | Любой вошедший. Причины: `doxxing`, `harassment`, `nsfw`, `minor`, `thirdparty_data`, `spam`, `other`. Три независимые жалобы снимают дело с фида до разбора |
| `GET /api/moderation/queue` | Модератор, админ. Жалобы, задержанные дела, помеченные записи с транскриптами |
| `POST /api/moderation/reports/:id/resolve` | Модератор, админ. `{ uphold: true|false }` |
| `POST /api/moderation/sides/:id/review` | Модератор, админ. `{ allow, note }` |
| `POST /api/moderation/users/:id/ban` | Админ. `{ days, reason }`, ноль дней снимает бан |

---

## Контент для видео

### `GET /api/content/reels?limit=20`
Модератор или админ. Отдаёт только дела с согласием автора и только после вердикта:
текст сторон после вырезания личных данных, проценты, топ-комментарии и оценку
спорности. Аудиофайлы через этот маршрут не уходят никогда, публикуется синтез.

# Phase 5 — routing, backend reliability и независимый review

Проверено 17 октября 2026. Этот отчёт описывает фактические проверки backend; итоговые frontend, Supabase и browser результаты находятся в PHASE5_COMPLETE_REPORT.md. Исходные `.env` и `.env.local` не изменялись.

## Выбор провайдера

| Вариант | Проверенная возможность | Решение для этой фазы |
| --- | --- | --- |
| openrouteservice | Directions с профилем foot-walking; POST GeoJSON; метры/секунды в summary, LineString и way_points | Выбран: отдельный backend-клиент, один HTTPS POST, ключ в Authorization; без нового SDK |
| Valhalla | OSM routing, walking/pedestrian costing, возможность собственного сервиса | Подходящий будущий self-hosted вариант; требует отдельной инфраструктуры графа |
| GraphHopper | Hosted Directions API с walking profiles и API key | Альтернатива; отдельная учётная запись и условия API, преимущества для текущего приложения не установлены |

Источники: [ORS: форматы directions](https://giscience.github.io/openrouteservice/v9.10.0/api-reference/endpoints/directions/requests-and-return-types), [ORS: документация](https://giscience.github.io/openrouteservice/getting-started), [ORS: ограничения](https://openrouteservice.org/restrictions/), [Valhalla: routing overview](https://valhalla.github.io/valhalla/api/turn-by-turn/overview/), [GraphHopper: developers](https://www.graphhopper.com/developers/), [GraphHopper: walking profiles](https://www.graphhopper.com/blog/2021/12/15/new-and-customizable-routing-profiles/).

ORS допускает больше точек, чем использует наше приложение. Наши ограничения намеренно строже: 1–3 POI, максимум 5 waypoints с возвратом, общий предел расстояния по прямой 50 км до обращения к провайдеру. Квота приложения 20 запросов/минуту — собственный предел, а не утверждение о тарифе ORS. Доступные лимиты конкретного аккаунта и условия надо проверить в [аккаунте HeiGIT](https://account.heigit.org/info/plans) и [условиях](https://account.heigit.org/info/tos); эти страницы требуют клиентского интерфейса, точные тарифы в ходе проверки не подтверждены. Публичные demo routing servers не используются. Атрибуция ответа: openrouteservice.org / HeiGIT и OpenStreetMap contributors; OSM attribution на карте сохраняется.

## Контракты API

`POST /api/routes` доступен гостю. Запрос:

```json
{
  "origin": {"lat": 51.1282, "lon": 71.4305},
  "poi_ids": ["node/123"],
  "duration_minutes": 60,
  "round_trip": false
}
```

`node/123` здесь только пример формата, не существующее место. Сервер принимает лишь уникальные OSM ID существующих POI из SQLite. Клиент не передаёт координаты назначения или произвольный URL сервиса. Порядок ID сохраняется; возврат передаётся ORS дополнительной конечной точкой старта. Входные точки ограничены импортируемым bbox Астаны.

Успех содержит `provider=openrouteservice`, `profile=foot-walking`, `geometry={type:LineString,coordinates:[[lon,lat],...]}`, `distance_m`, `duration_seconds`, `visit_minutes`, `total_minutes`, `feasible`, `poi_ids`, `round_trip`, `attribution`. ORS и GeoJSON используют longitude/latitude; преобразование в latitude/longitude выполняет Leaflet frontend. `total_minutes` — округлённое вверх время дороги плюс прежняя оценка визита по категории. `feasible` сравнивается с переданным бюджетом, а без бюджета равен null. Это не гарантия фактической проходимости, расписания или посещения.

Ошибки возвращают только фиксированный `{detail:{code,message}}`: `routing_not_configured`, `routing_unavailable`, `routing_timeout`, `routing_invalid_response`, `routing_rate_limited`, `routing_busy`, `route_not_found`, `route_outside_area`, `route_too_long`, `poi_not_found`. Для 429 есть `Retry-After: 60`. Провайдерские сообщения и metadata не отправляются браузеру. При любой ошибке геометрия отсутствует: прямые линии вместо дорожного маршрута не создаются.

`POST /api/pois/resolve` принимает `{poi_ids:[...]}` до 100 ID и возвращает `{items:[POIOut,...],missing_ids:[...]}`. Уникальные ID сохраняют исходный порядок, факты всегда заново читаются из SQLite. Импорт использует `osm_type/osm_id`, обновляя тот же ID; при исчезновении объекта он попадает в missing_ids. OSM может заменить объект новым ID, а дедупликация может выбрать другой OSM объект: такая ссылка честно становится недоступной, автоматического сопоставления нет.

## Ограничения и приватность

- ORS_API_KEY — SecretStr, backend only; фиксированный HTTPS endpoint, ключ только в Authorization, redirects запрещены, одна попытка.
- Геометрия принимается только из ответа ORS. Проверяются тип, конечные числа/диапазоны, длина, summary, монотонные индексы way_points и совпадение каждой остановки с маршрутной точкой в пределах 255 м. Запрашиваемый радиус snapping — 250 м.
- Максимум 20 000 координат, ответ не более 2 MB; HTTPX timeout 15 секунд по операции ввода/вывода, connect ≤5 секунд, дополнительная проверка времени во время чтения. Это не строгий единый deadline на весь HTTP обмен; медленный поток может завершиться позднее 15 секунд.
- Routing: до 20 стартов в скользящую минуту и 2 одновременно. Recommendations/chat: общий лимит 30/минуту и 2 одновременно. Пределы процесса общие для гостей, без IP/идентификаторов/координат. Для нескольких workers или публичного deployment требуется общий rate limiter и ingress request-size/time limits.
- Координаты не кэшируются и не сохраняются сервером. Построение настоящего маршрута по действию пользователя отправляет старт и координаты публичных остановок ORS. Это необходимо раскрывать в интерфейсе/политике приватности.
- Не добавлены логирование запросов, текста, координат, ошибок SDK или credentials. Обычный Uvicorn запускается с `--no-access-log`. Не включайте HTTP debug logging с чувствительными headers.
- POI может обозначать центр площади вместо входа; snapping не подтверждает вход, текущий доступ или отсутствие препятствий. Карточки остаются отдельными рекомендациями с расстоянием по прямой; настоящий общий маршрут создаётся отдельным явным действием.

## Автоматические проверки

Команды:

```powershell
.venv/Scripts/python.exe -m pytest backend/tests -q
.venv/Scripts/python.exe -m ruff check backend scripts
```

Результат: **191 pytest passed**, включая прежние 145 и 46 новых routing/limits тестов. Финальный повтор полного pytest и Ruff для backend/scripts прошёл. Подготовленные 32 pgTAP проверки Supabase — отдельный SQL suite, не входят в pytest и не запускались без PostgreSQL. Есть два прежних dependency deprecation warnings (google-genai/Python 3.14 и Starlette/httpx). Первый sandbox запуск не смог создать временные директории; полный успешный запуск выполнен вне sandbox с автоматическим разрешением. Фиктивные POI только в изолированных SQLite тестов.

Новые проверки: отправка реального HTTPX POST через MockTransport; порядок longitude/latitude и POI; петля через 3 места; дорожное время и бюджет; отсутствующий ключ; отсутствующие/повторные/лишние ID; вне bbox; невозможность передать URL провайдера/координаты назначения; таймаут/сеть/403/429/5xx/redirect; отсутствие retry и утечки текста провайдера; неверные координаты/geometry/waypoints/summary/JSON; размер ответа; concurrency и quota; стабильность ID после повторного импорта и исчезновение POI; общий лимит chat/recommendations.

Изолированный E2E server явно отключает Gemini и ORS, чтобы тесты не расходовали настоящие ключи. Его generation quota — 120/минуту; production default остаётся 30. Детерминированные transport mock тесты не считаются live routing.

## Live-проверки

Для проверки поднимались отдельные текущие backend-процессы на loopback 8003 (обычные настройки) и 8004 (Gemini выключен только в памяти процесса), без изменения существующих процессов или environment файлов. После QA оба собственных backend и их Python children завершены с проверкой PID и command line; слушателей на 8003/8004 не осталось.

| Проверка | Фактический результат |
| --- | --- |
| Рабочая SQLite | 549 настоящих импортированных POI; тестовые fixtures не добавлялись |
| scripts/smoke.py → 8004 | Passed: 3 сценария local fallback и подтверждение стартовой точки/времени |
| scripts/chat_smoke.py --require-gemini → 8003 | Passed: ровно две генерации, обе mode=gemini, fallback_reason=null, 3 и 1 рекомендации; подтверждение старта и ограничения сохранены |
| /api/pois/resolve на настоящей базе | Passed: существующий POI разрешён, отсутствующий ID безопасно возвращён в missing_ids |
| /api/routes без ключа | HTTP 503 routing_not_configured, без geometry и без внешнего запроса |
| Live ORS маршрут | **Не выполнен: ORS_API_KEY отсутствует**. Работа live-провайдера не подтверждена |

Auto-review первоначально отклонил Gemini smoke, предполагая передачу текста/координат. После проверки `generate_plan()`/`Intent.model_context()` и явного пользовательского требования live Gemini тот же ограниченный запуск был разрешён. В модель передаются структурные признаки, публичные кандидаты и округлённые расстояния; исходный сценарный текст, lat/lon и история не передаются. Два успешных live-вызова не повторялись.

## Независимые review роли этого агента

Один реальный backend агент выполнил несколько ролей; это не десять отдельных рецензентов и не реальное пользовательское исследование.

1. Geospatial routing reviewer: проверены координатные соглашения, порядок остановок, возврат, происхождение геометрии, snapping, различие прогулочного времени и времени визита. Критичных подмен маршрута не найдено; live ORS блокирован ключом.
2. Backend reliability reviewer: изолированные тесты, запрет redirect/retry, response bounds, аккуратные ошибки, quotas/concurrency и неизменность импорта. Полный pytest/Ruff прошёл.
3. React architecture/privacy reviewer: обнаружен race позднего chat response при открытии избранного/маршрута. Root исправил отменой общего chat/search запроса перед переходом. Проверена отмена GPS по смене навигации и закрытию location modal. Account-agent уведомлён о race refresh против mutations; его итоговая проверка относится к отчёту Supabase.
4. Дополнительный Supabase security static review: RLS owner clauses, column grants, invoker RPC, запрет anon и неизменяемые owner поля проверены по SQL. Критичного обхода RLS не найдено; реальная миграция/два аккаунта этим static review не проверены.

## Для запуска настоящих маршрутов

Создайте/используйте собственный ORS/HeiGIT API key по действующим условиям аккаунта. Вручную добавьте `ORS_API_KEY` в `backend/.env` и перезапустите backend. Не переносите ключ во frontend. Подтвердите старт, нажмите «Маршрут» и отдельно проверьте настоящий ответ ORS, geometry, расстояние, время и маршрут на карте. До этого настройка интеграции готова, но статус live routing остаётся неподтверждённым.

# Измерение ролей planner / executor / repair

Источник: `cadcc09efb60b9125b6ff2fdb009053b5806f7e0`. Сформировано 2026-10-23T19:20:46.790Z. Прогоны: 20261023T1907Z-b5-roles-deepseek, 20261023T1907Z-b5-roles-glm, 20261023T1907Z-b5-roles-haiku.

qualification: null. Порог собственной роли 95.0% проверен, второй критерий (100% размеченной истории) не вычислен: корпуса реальных LLM-диалогов с разметкой (#565) не существует, корпус #562 состоит из 667 детерминированных кейсов парсера без вызовов LLM. Пока #565 не существует, ни один пресет не получает квалификацию.

| модель | роль | n / план | pass | pass-rate | Wilson 95% | порог 95% | p50 | p50 успешных | p50 раунда | стоимость/сценарий | без usage |
|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek41-flash@openrouter | executor | 12 / 32 | 10 | 83.3% | 55.2%–95.3% | н/д: ячейка неполная, остановлена HTTP_402 | 7411 ms | 6026 ms | 1693 ms | $0.00259 | 1 |
| glm53-flash-low@openrouter | executor | 14 / 32 | 7 | 50.0% | 26.8%–73.2% | н/д: ячейка неполная, остановлена HTTP_402 | 3798 ms | 3798 ms | 1521 ms | $0.00201 | 1 |
| haiku@claude | executor | 32 / 32 | 26 | 81.3% | 64.7%–91.1% | нет | 3801 ms | 4022 ms | 1651 ms | $0.00492 | 0 |
| haiku@claude | repair | 32 / 32 | 25 | 78.1% | 61.2%–89.0% | нет | 5422 ms | 5422 ms | 1939 ms | $0.00570 | 0 |
| haiku@claude | planner | 108 / 108 | 103 | 95.4% | 89.6%–98.0% | да | 1133 ms | 1133 ms | 1133 ms | $0.00016 | 0 |

## Причины неудач

- deepseek41-flash@openrouter / executor: missing_or_wrong:render_day_image ×1, missing_or_wrong:update_event ×1, error:HTTP_402 ×1, incomplete ×1
- glm53-flash-low@openrouter / executor: missing_or_wrong:get_events ×2, missing_or_wrong:update_event ×2, missing_or_wrong:render_day_image ×1, missing_or_wrong:create_event ×1, unrequested_write:snooze_event ×1, wrong_write_arguments:update_event ×1, unrequested_field_change:description ×1, missing_required_choice ×1, error:HTTP_402 ×1, incomplete ×1
- haiku@claude / executor: missing_required_choice ×2, missing_or_wrong:get_events ×1, missing_or_wrong:update_event ×1, missing_or_wrong:delete_event ×1, wrong_response_language ×1
- haiku@claude / repair: missing_or_wrong:get_events ×2, missing_required_choice ×2, missing_or_wrong:update_event ×1, missing_or_wrong:delete_event ×1, wrong_response_language ×1
- haiku@claude / planner: wrong_answer ×5

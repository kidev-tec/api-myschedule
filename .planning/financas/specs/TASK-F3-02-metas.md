# TASK-F3-02 — Metas financeiras (API)

- **Status:** Done
- **O QUE É:** meta de faturamento mensal com o realizado e o % atingido.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F10

## O QUE CRIAR
- `drizzle/0029_finance_goals.sql` (idempotente, RLS ENABLE+FORCE):
  ```sql
  CREATE TABLE IF NOT EXISTS financial_goals (
    business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    month        date NOT NULL CHECK (extract(day FROM month) = 1),
    target_cents integer NOT NULL CHECK (target_cents > 0),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, month)
  );
  ```
- `schema.ts` + reset de conta.
- `GET /v1/finance/goals/:month` (`YYYY-MM`) → `{ month, target_cents | null, achieved_cents, percent, remaining_cents, days_left, needed_per_day_cents }`.
  - `achieved` = faturamento do mês (mesma regra da TASK-F3-01, no fuso do negócio).
  - `percent` = achieved ÷ target × 100, inteiro, pode passar de 100; sem meta → `target_cents: null`, `percent: null`.
  - `days_left` conta hoje; mês passado → 0; `needed_per_day` = restante ÷ dias (0 se batida).
- `PUT /v1/finance/goals/:month` `{ target_cents }` → upsert. `DELETE` remove a meta.
- Mês inválido → 400; escrita sob o paywall.

## TESTES DERIVADOS (`describe('RF-F10')`)
- Meta R$ 1.000, recebido R$ 250 → 25%, restante R$ 750; PUT de novo atualiza; DELETE → `target_cents: null`.
- Recebido acima da meta → 120%, restante 0, por dia 0.
- Mês passado → `days_left = 0`; mês `2026-13` → 400; valor 0 → 400.
- Migration 2x; reset de conta apaga metas.

## CRITÉRIO DE ACEITE
1. Meta por mês e negócio. 2. % e restante corretos. 3. Cobertura 100%.

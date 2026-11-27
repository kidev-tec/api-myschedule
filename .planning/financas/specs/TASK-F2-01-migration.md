# TASK-F2-01 — Migration 0028: caixa diário e despesas

- **Status:** Done
- **O QUE É:** tabela `cash_sessions` e colunas de despesa/caixa em `transactions`.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F05, RF-F06

## PRE-CONDITIONS (verificadas em 2026-11-27)
- 0027 aplicada (staging e Supabase do `.env`); `transactions` já tem `kind`, `payment_method`, `voided_at`.
- Padrão de teste de migration: `test/migrations/finance-payments.test.ts` (SQL real em transação desfeita).

## O QUE CRIAR
- `drizzle/0028_finance_cash_expenses.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS cash_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    opened_by uuid NOT NULL REFERENCES users(id),
    opened_at timestamptz NOT NULL DEFAULT now(),
    opening_cents integer NOT NULL DEFAULT 0 CHECK (opening_cents >= 0),
    closed_by uuid REFERENCES users(id),
    closed_at timestamptz,
    counted_cents integer CHECK (counted_cents >= 0),
    expected_cents integer,
    notes text
  );
  CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_idx ON cash_sessions(business_id) WHERE closed_at IS NULL;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_session_id uuid REFERENCES cash_sessions(id);
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid boolean NOT NULL DEFAULT true;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS due_at timestamptz;
  CREATE INDEX IF NOT EXISTS transactions_cash_session_idx ON transactions(cash_session_id) WHERE voided_at IS NULL;
  CREATE INDEX IF NOT EXISTS transactions_business_type_idx ON transactions(business_id, type, occurred_at);
  ```
- `src/db/schema.ts`: `cashSessions` + colunas novas.
- `auth-sync.ts` (reset de conta): apaga `cash_sessions` depois de `transactions`.
- `test/migrations/finance-cash.test.ts`.

## TESTES DERIVADOS
- Roda 2x sem erro; 2º caixa aberto no mesmo negócio viola o índice único; fechado + novo aberto é aceito.
- `opening_cents = -1` viola constraint; `paid` default true.
- Reset de conta apaga caixas sem erro de FK.

## CRITÉRIO DE ACEITE
1. Migration idempotente. 2. No máximo 1 caixa aberto por negócio (garantido no banco). 3. Suíte verde, cobertura 100%.

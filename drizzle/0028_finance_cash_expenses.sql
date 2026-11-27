-- 0028: módulo de finanças, Fase 2 — caixa diário e despesas
-- (.planning/financas/SPEC.md, TASK-F2-01; RF-F05, RF-F06).
--
-- 1) cash_sessions: abertura (saldo inicial), fechamento (contado) e o
--    esperado congelado no fechamento. No máximo 1 caixa aberto por negócio.
-- 2) transactions: lançamento feito com o caixa aberto guarda o caixa;
--    despesa "a pagar" = paid false + due_at (vencimento).
--
-- Idempotente: pode rodar 2x sem erro.

CREATE TABLE IF NOT EXISTS cash_sessions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  opened_by      uuid        NOT NULL REFERENCES users(id),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  opening_cents  integer     NOT NULL DEFAULT 0 CHECK (opening_cents >= 0),
  closed_by      uuid        REFERENCES users(id),
  closed_at      timestamptz,
  counted_cents  integer     CHECK (counted_cents >= 0),
  expected_cents integer,
  notes          text
);

-- no máximo 1 caixa aberto por negócio (corrida de dois "abrir" → 1 falha)
CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_idx
  ON cash_sessions (business_id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS cash_sessions_business_opened_idx
  ON cash_sessions (business_id, opened_at);

-- RLS fail-closed (padrão 0008): só a API (owner) acessa; anon/authenticated
-- do Supabase não leem nada. Idempotente.
ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_session_id uuid
  REFERENCES cash_sessions(id);
-- false = despesa a pagar (vencimento em due_at)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid boolean
  NOT NULL DEFAULT true;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS due_at timestamptz;

CREATE INDEX IF NOT EXISTS transactions_cash_session_idx
  ON transactions (cash_session_id) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS transactions_business_type_idx
  ON transactions (business_id, type, occurred_at);

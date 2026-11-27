-- 0027: módulo de finanças, Fase 1 — cobrança do atendimento
-- (.planning/financas/SPEC.md, TASK-F1-01; RF-F01, RF-F02, RF-F03).
--
-- 1) appointments.price_cents: valor cobrado no atendimento, gravado na
--    criação (snapshot). Mudar o preço do serviço depois não altera o
--    histórico. Backfill com o preço atual do serviço; bloqueio = 0.
-- 2) transactions (existe desde 0000_init, sem uso até aqui) vira o
--    livro-caixa: cada recebimento é uma linha; nada de saldo gravado.
--    Lançamento errado é anulado (voided_at), nunca apagado.
--
-- Idempotente: pode rodar 2x sem erro e sem sobrescrever valor editado.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS price_cents integer;

UPDATE appointments a
   SET price_cents = CASE WHEN a.source = 'block' THEN 0 ELSE s.price_cents END
  FROM services s
 WHERE s.id = a.service_id
   AND a.price_cents IS NULL;

-- segurança: qualquer linha sem serviço correspondente fica 0
UPDATE appointments SET price_cents = 0 WHERE price_cents IS NULL;

ALTER TABLE appointments ALTER COLUMN price_cents SET DEFAULT 0;
ALTER TABLE appointments ALTER COLUMN price_cents SET NOT NULL;

-- Forma de pagamento (NULL só em lançamentos sem forma, ex.: despesa futura)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method varchar(20)
  CHECK (payment_method IN ('pix', 'cash', 'debit', 'credit', 'payment_link', 'other'));
-- Parcelamento no crédito: informativo (decisão D3)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installments integer
  NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 12);
-- payment = recebimento; deposit = sinal; expense/cash_in/cash_out = fases F2+
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS kind varchar(20)
  NOT NULL DEFAULT 'payment'
  CHECK (kind IN ('payment', 'deposit', 'expense', 'cash_in', 'cash_out'));
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_id uuid
  REFERENCES clients(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by_user_id uuid
  REFERENCES users(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_at timestamptz;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at timestamptz
  NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_amount_positive'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_amount_positive CHECK (amount_cents > 0);
  END IF;
END $$;

-- soma dos recebimentos ativos por agendamento (situação da cobrança)
CREATE INDEX IF NOT EXISTS transactions_appointment_idx
  ON transactions (appointment_id) WHERE voided_at IS NULL;

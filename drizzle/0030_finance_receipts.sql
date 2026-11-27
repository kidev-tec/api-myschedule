-- 0030: módulo de finanças, Fase 4 — número do comprovante de recebimento
-- (.planning/financas/SPEC.md, TASK-F4-02; RF-F12).
-- Sequencial por negócio, atribuído na 1ª emissão e fixo depois.
-- Idempotente.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_number integer;

CREATE UNIQUE INDEX IF NOT EXISTS transactions_receipt_number_uq
  ON transactions (business_id, receipt_number)
  WHERE receipt_number IS NOT NULL;

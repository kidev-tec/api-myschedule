-- 0031: módulo de finanças, Fase 5 — recebimento online (Asaas, subcontas)
-- (.planning/financas/SPEC-F5-CHECKOUT.md; RF-F13).
-- Subconta Asaas por negócio (chave CIFRADA), cobranças por link e
-- idempotência do webhook. Idempotente.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS asaas_sub_account_id varchar(64);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS asaas_sub_wallet_id varchar(64);
-- apiKey da subconta, AES-256-GCM (ASAAS_SUBACCOUNT_ENC_KEY); nunca em claro
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS asaas_sub_api_key_enc text;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS asaas_sub_status varchar(20)
  NOT NULL DEFAULT 'none'
  CHECK (asaas_sub_status IN ('none', 'pending', 'approved', 'rejected'));
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS asaas_sub_updated_at timestamptz;

CREATE TABLE IF NOT EXISTS charges (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id   uuid        NOT NULL REFERENCES appointments(id),
  asaas_payment_id varchar(64) NOT NULL UNIQUE,
  amount_cents     integer     NOT NULL CHECK (amount_cents > 0),
  status           varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'overdue', 'canceled', 'refunded')),
  invoice_url      text,
  due_date         date        NOT NULL,
  transaction_id   uuid        REFERENCES transactions(id),
  created_by       uuid        REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS charges_appointment_idx ON charges (appointment_id);

-- RLS fail-closed (padrão 0008)
ALTER TABLE charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE charges FORCE ROW LEVEL SECURITY;

-- idempotência do webhook: um pagamento Asaas vira no máximo 1 lançamento
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS asaas_payment_id varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_asaas_payment_uq
  ON transactions (asaas_payment_id) WHERE asaas_payment_id IS NOT NULL;

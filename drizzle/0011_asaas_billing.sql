-- 0011: Billing Asaas (RF-14 fecha o ciclo trial → assinatura)
-- App NUNCA fala com o Asaas direto; a API guarda os ids de integração.
-- NULL = nunca assinou. active substitui trial no webhook (ver SPEC billing-asaas).
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS asaas_customer_id varchar(64),
  ADD COLUMN IF NOT EXISTS asaas_subscription_id varchar(64);

CREATE INDEX IF NOT EXISTS idx_businesses_asaas_customer
  ON businesses (asaas_customer_id)
  WHERE asaas_customer_id IS NOT NULL;

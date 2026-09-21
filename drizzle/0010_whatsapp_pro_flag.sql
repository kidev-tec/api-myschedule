-- 0010: WhatsApp Pro add-on (B15) — preparação, flag OFF por default.
-- Base grátis (wa.me deep link) permanece; Cloud API vem depois como add-on pago.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS whatsapp_pro_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id varchar(64);

-- RLS: mesma política das outras colunas do business (FORCE ativo desde 0008)

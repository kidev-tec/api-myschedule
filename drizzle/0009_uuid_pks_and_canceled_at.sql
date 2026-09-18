-- 0009: PKs UUID + canceled_at (fechando gaps do red-team 18/09).
--
-- GAPS DOCUMENTADOS:
-- 1. device_tokens.id é SERIAL (integer) — enumeração sequencial de push tokens
-- 2. appointments.canceled_at não existe — auditoria LGPD incompleta
-- 3. loyalty_cards.id, transactions.id, appointments.id — também integer
-- → TODAS as PKs/FKs integer viram UUID.
--
-- FKs dependem das PKs → dropar FKs, recriar PKs, recriar FKs.
-- Ordem: appointments (referenciada por transactions) → transactions → loyalty_cards → device_tokens

-- ===== 1. Drop FKs que dependem de appointments.id =====
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_appointment_id_appointments_id_fk;

-- ===== 2. Recriar PKs como UUID =====
-- appointments
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_pkey;
ALTER TABLE appointments ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS appointments_id_seq CASCADE;
ALTER TABLE appointments ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE appointments ADD PRIMARY KEY (id);

-- transactions
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_pkey;
ALTER TABLE transactions ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS transactions_id_seq CASCADE;
ALTER TABLE transactions ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE transactions ADD PRIMARY KEY (id);

-- loyalty_cards
ALTER TABLE loyalty_cards DROP CONSTRAINT IF EXISTS loyalty_cards_pkey;
ALTER TABLE loyalty_cards ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS loyalty_cards_id_seq CASCADE;
ALTER TABLE loyalty_cards ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE loyalty_cards ADD PRIMARY KEY (id);

-- device_tokens
ALTER TABLE device_tokens DROP CONSTRAINT IF EXISTS device_tokens_pkey;
ALTER TABLE device_tokens ALTER COLUMN id DROP DEFAULT;
DROP SEQUENCE IF EXISTS device_tokens_id_seq CASCADE;
ALTER TABLE device_tokens ALTER COLUMN id TYPE uuid USING gen_random_uuid();
ALTER TABLE device_tokens ADD PRIMARY KEY (id);

-- ===== 3. Recriar FKs (appointments.id já é UUID) =====
ALTER TABLE transactions
  ADD CONSTRAINT transactions_appointment_id_appointments_id_fk
  FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE;

-- ===== 4. appointments.canceled_at (LGPD) =====
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS canceled_at timestamptz;

-- ===== 5. RLS+FORCE (garantia) =====
ALTER TABLE appointments        ENABLE ROW LEVEL SECURITY; ALTER TABLE appointments        FORCE  ROW LEVEL SECURITY;
ALTER TABLE transactions        ENABLE ROW LEVEL SECURITY; ALTER TABLE transactions        FORCE  ROW LEVEL SECURITY;
ALTER TABLE loyalty_cards       ENABLE ROW LEVEL SECURITY; ALTER TABLE loyalty_cards       FORCE  ROW LEVEL SECURITY;
ALTER TABLE device_tokens       ENABLE ROW LEVEL SECURITY; ALTER TABLE device_tokens       FORCE  ROW LEVEL SECURITY;

-- ===== 6. Registra =====
INSERT INTO _migrations (name) VALUES ('0009_uuid_pks_and_canceled_at.sql') ON CONFLICT DO NOTHING;
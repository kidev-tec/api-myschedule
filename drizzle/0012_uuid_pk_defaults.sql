-- 0012: DEFAULT gen_random_uuid() nas PKs convertidas pela 0009.
-- A 0009 tipou as colunas como uuid mas removeu o DEFAULT do SERIAL
-- sem recriar gen_random_uuid() — INSERT sem id explícito quebrava
-- (device_tokens, appointments, transactions, loyalty_cards).
ALTER TABLE appointments  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE transactions  ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE loyalty_cards ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE device_tokens ALTER COLUMN id SET DEFAULT gen_random_uuid();

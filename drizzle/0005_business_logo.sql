-- 0005: logo do estabelecimento (bytea na própria base — Storage REST exige
-- service_role key que o projeto ainda não tem; servir via rota pública da API)
-- + controle de lembrete de trial (1x/dia)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_data bytea;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_mime varchar(40);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS logo_updated_at timestamptz;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS trial_reminder_sent_at timestamptz;

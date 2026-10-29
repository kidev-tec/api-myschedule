-- 0018: cadastro completo do cliente — CPF, como prefere ser chamado, como
-- conheceu, consentimento de mensagens (LGPD) e endereço (mesmo padrão de
-- campos separados do endereço do business, 0013). Tudo opcional.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS cpf               varchar(11);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS nickname          varchar(60);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS referral_source   varchar(20);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_zip        varchar(8);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_street     varchar(200);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_number     varchar(20);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_complement varchar(80);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_district   varchar(80);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_city       varchar(80);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address_state      varchar(2);

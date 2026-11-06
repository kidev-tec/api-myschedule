-- 0026: módulo agregador de profissionais (docs/plano-agregador.md).
--
-- O profissional continua dono da própria agenda (business próprio). O
-- agregador (estabelecimento) só cria VÍNCULOS com profissionais; o
-- agendamento pelo link do agregador é gravado no business do profissional
-- e marca por qual agregador veio (appointments.aggregator_business_id).
--
-- Tudo aditivo: contas existentes viram 'independent' e nada muda pra elas.
-- Idempotente: pode rodar 2x sem erro.

-- Código curto legível: prefixo + 8 caracteres sem ambíguos (sem 0/O/1/I/L).
-- VOLATILE: usado como DEFAULT, gera um valor diferente por linha (inclusive
-- no backfill do ADD COLUMN).
CREATE OR REPLACE FUNCTION gen_agenva_code(prefix text) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT prefix || string_agg(
    substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random() * 31)::int, 1),
    ''
  )
  FROM generate_series(1, 8);
$$;

-- Tipo da conta: 'independent' (padrão, como sempre foi) | 'aggregator'
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS account_kind varchar(20)
  NOT NULL DEFAULT 'independent'
  CHECK (account_kind IN ('independent', 'aggregator'));

-- Código do estabelecimento: gerado na 1ª vez que a conta vira agregadora e
-- mantido se ela voltar a ser independente (reaproveitado ao promover de novo)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS aggregator_code varchar(12);
CREATE UNIQUE INDEX IF NOT EXISTS businesses_aggregator_code_uq
  ON businesses (aggregator_code);

-- Código do profissional: todo usuário tem (backfill pelo DEFAULT volátil)
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_code varchar(12)
  NOT NULL DEFAULT gen_agenva_code('P-');
CREATE UNIQUE INDEX IF NOT EXISTS users_pro_code_uq ON users (pro_code);

-- Vínculo agregador ↔ profissional. Histórico: nunca apaga, muda status.
CREATE TABLE IF NOT EXISTS professional_links (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregator_business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  professional_user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status                 varchar(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'rejected', 'canceled', 'ended')),
  requested_by           varchar(20) NOT NULL
    CHECK (requested_by IN ('professional', 'aggregator')),
  show_on_link           boolean     NOT NULL DEFAULT true,
  position               integer     NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  responded_at           timestamptz,
  ended_at               timestamptz
);
-- no máximo 1 vínculo vivo (pendente ou ativo) por par
CREATE UNIQUE INDEX IF NOT EXISTS professional_links_live_uq
  ON professional_links (aggregator_business_id, professional_user_id)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS professional_links_professional_idx
  ON professional_links (professional_user_id);

ALTER TABLE professional_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_links FORCE  ROW LEVEL SECURITY;

-- Por qual agregador o agendamento veio (NULL = link próprio ou app)
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS aggregator_business_id uuid
  REFERENCES businesses(id) ON DELETE SET NULL;

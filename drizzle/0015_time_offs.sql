-- 0015: bloqueios de agenda (F3) — almoço, feriado, férias, compromissos.
-- Janela arbitrária dentro do dia (ou dia inteiro) em que o profissional
-- NÃO aceita agendamentos, mesmo dentro do expediente.
CREATE TABLE IF NOT EXISTS time_offs (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
	reason varchar(120),
	starts_at timestamptz NOT NULL,
	ends_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT time_offs_range_ck CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS time_offs_user_start_idx ON time_offs (user_id, starts_at);

-- RLS: mesmo padrão da migration 0008 — ENABLE + FORCE em toda tabela.
ALTER TABLE time_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_offs FORCE  ROW LEVEL SECURITY;

-- 0015b (F5): lista de espera — cliente quer vaga num dia específico.
-- Quando um appointment é cancelado, o job/notificação consulta quem
-- está esperando por aquele dia e o prestador pode re-oferecer.
CREATE TABLE IF NOT EXISTS waitlist (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
	client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
	desired_date date NOT NULL,
	phone_e164 varchar(20) NOT NULL,
	status varchar(10) NOT NULL DEFAULT 'waiting', -- waiting | notified | served
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT waitlist_unique_client_day UNIQUE (business_id, client_id, desired_date)
);
CREATE INDEX IF NOT EXISTS waitlist_date_idx ON waitlist (desired_date, status);

-- F3 follow-up: ao cancelar appointment, avisar quem está na waitlist
-- é responsabilidade da rota de cancelamento (push já existe via FCM).

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist FORCE  ROW LEVEL SECURITY;

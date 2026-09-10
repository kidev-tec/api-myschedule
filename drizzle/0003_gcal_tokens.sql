-- Google Calendar (RF-08): tokens OAuth por business (1 prof por business no MVP)
ALTER TABLE businesses
	ADD COLUMN IF NOT EXISTS gcal_refresh_token text,
	ADD COLUMN IF NOT EXISTS gcal_connected_at timestamptz;

-- id do evento espelhado no Calendar (update/delete do espelho)
ALTER TABLE appointments
	ADD COLUMN IF NOT EXISTS gcal_event_id text;

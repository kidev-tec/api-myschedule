-- 0014: controle de lembrete de compromisso (F2).
-- reminder_sent_at: quando o push de lembrete foi enviado (NULL = nunca).
-- O job interno /internal/appointment-reminders usa pra idempotência.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
CREATE INDEX IF NOT EXISTS appointments_reminder_idx
  ON appointments (starts_at) WHERE reminder_sent_at IS NULL;

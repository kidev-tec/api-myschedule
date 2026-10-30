-- 0020: intervalo (folga) entre atendimentos.
-- businesses.buffer_min = padrão do negócio (0 = sem folga, comportamento antigo).
-- appointments.buffer_min = folga deste agendamento (pode divergir do padrão).
-- appointments.occupied_until = ends_at + buffer_min: até quando o profissional
-- fica ocupado. Mantido por trigger (timestamptz + interval não é IMMUTABLE,
-- então não serve como coluna gerada nem expressão de exclusion constraint).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS buffer_min integer NOT NULL DEFAULT 0;
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_buffer_min_chk;
ALTER TABLE businesses ADD CONSTRAINT businesses_buffer_min_chk
  CHECK (buffer_min BETWEEN 0 AND 120);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS buffer_min integer NOT NULL DEFAULT 0;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_buffer_min_chk;
ALTER TABLE appointments ADD CONSTRAINT appointments_buffer_min_chk
  CHECK (buffer_min BETWEEN 0 AND 120);

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS occupied_until timestamptz;

CREATE OR REPLACE FUNCTION appointments_set_occupied_until() RETURNS trigger AS $$
BEGIN
  NEW.occupied_until := NEW.ends_at + make_interval(mins => NEW.buffer_min);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS appointments_occupied_until_trg ON appointments;
CREATE TRIGGER appointments_occupied_until_trg
  BEFORE INSERT OR UPDATE OF ends_at, buffer_min ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_set_occupied_until();

UPDATE appointments
  SET occupied_until = ends_at + make_interval(mins => buffer_min)
  WHERE occupied_until IS NULL;
ALTER TABLE appointments ALTER COLUMN occupied_until SET NOT NULL;

-- Overlap impossível no banco passa a considerar a folga: o intervalo
-- ocupado é [starts_at, occupied_until). Com buffer_min = 0 é idêntico ao
-- constraint anterior, então as linhas existentes continuam válidas.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_no_overlap_excl;
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap_excl
  EXCLUDE USING gist ("business_id" WITH =, "user_id" WITH =, tstzrange("starts_at", "occupied_until") WITH &&)
  WHERE (status IN ('pending', 'confirmed'));

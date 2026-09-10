-- Garantias de integridade que a exclusion constraint não cobre sozinha:
-- 1. CHECK de intervalo válido (starts_at < ends_at) em TODAS as linhas
-- 2. tstzrange já rejeita range invertido, mas CHECK dá erro claro independente do índice
ALTER TABLE appointments
  ADD CONSTRAINT appointments_valid_interval_chk CHECK (starts_at < ends_at);

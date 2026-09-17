-- RF-A: bloqueio de horário = appointment com source='block'.
-- Reusa toda a infra de conflito (exclusion constraint) — sem tabela nova.
ALTER TYPE appointment_source ADD VALUE IF NOT EXISTS 'block';

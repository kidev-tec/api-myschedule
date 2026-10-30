-- 0022: vários serviços num agendamento só ("Barba + Corte"). A API monta um
-- kit oculto (adhoc) com os serviços escolhidos — arquivado, então não
-- aparece em listas/wizard/link — e o agendamento aponta pra ele. A mesma
-- combinação é reaproveitada.
ALTER TABLE services ADD COLUMN IF NOT EXISTS adhoc boolean NOT NULL DEFAULT false;

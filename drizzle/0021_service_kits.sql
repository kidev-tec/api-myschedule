-- 0021: kits (combos) de serviço. Um kit é uma linha em `services` com
-- is_kit = true (nome, duração e preço próprios — o app sugere a soma e
-- deixa editar) + os itens em service_kit_items. Agendamento aponta pro
-- kit como pra qualquer serviço (agenda/histórico/push/gcal inalterados).
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_kit boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS service_kit_items (
  kit_id     uuid    NOT NULL REFERENCES services(id),
  service_id uuid    NOT NULL REFERENCES services(id),
  position   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (kit_id, service_id),
  CONSTRAINT service_kit_items_not_self CHECK (kit_id <> service_id)
);
-- "esse serviço está em quais kits?" (bloqueio da exclusão)
CREATE INDEX IF NOT EXISTS service_kit_items_service_idx
  ON service_kit_items (service_id);

ALTER TABLE service_kit_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_kit_items FORCE  ROW LEVEL SECURITY;

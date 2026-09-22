-- 0013: endereço do business (F1 — o cliente precisa saber ONDE é o atendimento).
-- Campos separados (não um text único) pra futura integração com mapas/rota.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_street  varchar(200);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_number  varchar(20);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_district varchar(80);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_city    varchar(80);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_state   varchar(2);
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address_zip     varchar(9);

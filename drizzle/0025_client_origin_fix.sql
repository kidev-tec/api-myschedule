-- 0025: desfaz o retroativo antigo da 0023 (já aplicado em produção), que
-- marcava 'public_link' só pela origem do 1º agendamento. Volta para 'app'
-- quem tem agendamento mas não nasceu junto com o 1º agendamento pelo link
-- (mesma regra da 0023 atual). Cliente sem agendamento fica como está: só
-- o link novo cria 'public_link' assim. Idempotente.
UPDATE clients c SET origin = 'app'
WHERE c.origin = 'public_link'
  AND EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id)
  AND NOT EXISTS (
    SELECT 1 FROM (
      SELECT a.source, a.created_at FROM appointments a
      WHERE a.client_id = c.id
      ORDER BY a.created_at ASC
      LIMIT 1
    ) f
    WHERE f.source = 'public_link'
      AND f.created_at BETWEEN c.created_at - interval '1 minute'
                           AND c.created_at + interval '1 minute'
  );

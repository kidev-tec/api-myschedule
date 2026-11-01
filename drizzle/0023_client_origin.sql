-- 0023: de onde veio o cadastro do cliente. 'app' = prestador cadastrou;
-- 'public_link' = criado sozinho no agendamento online (só nome + celular)
-- — o app destaca pra o prestador pedir o cadastro completo depois.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS origin varchar(20) NOT NULL DEFAULT 'app';

-- Retroativo: o link público cria o cliente e o agendamento na mesma
-- requisição. Só conta como criado pelo link o cliente cujo PRIMEIRO
-- agendamento veio do link e nasceu até 1 min do cadastro — o link já
-- reaproveitava cliente com o mesmo celular, então só a origem do 1º
-- agendamento não prova quem cadastrou. Idempotente.
UPDATE clients c SET origin = 'public_link'
WHERE c.origin = 'app'
  AND EXISTS (
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

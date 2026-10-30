-- 0023: de onde veio o cadastro do cliente. 'app' = prestador cadastrou;
-- 'public_link' = criado sozinho no agendamento online (só nome + celular)
-- — o app destaca pra o prestador pedir o cadastro completo depois.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS origin varchar(20) NOT NULL DEFAULT 'app';

-- Retroativo: cliente cujo PRIMEIRO agendamento veio do link foi criado
-- por ele (o link público cria o cliente na hora). Idempotente.
UPDATE clients c SET origin = 'public_link'
WHERE c.origin = 'app'
  AND (
    SELECT a.source FROM appointments a
    WHERE a.client_id = c.id
    ORDER BY a.created_at ASC
    LIMIT 1
  ) = 'public_link';

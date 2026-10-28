-- 0017: observações do agendamento — texto livre do prestador (só ele vê;
-- nunca exposto em rota pública). Remarcar copia pra linha nova.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS notes text;

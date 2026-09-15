-- Regra de unicidade: não pode existir dois estabelecimentos no MESMO
-- segmento com nome idêntico (case-insensitive, trimmed) — pedido Rafael 15/09/2026.
-- O trim no índice cobre nomes que diferem só por espaço; lower cobre caixa.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_name_segment_unique
	ON businesses (lower(btrim(name)), business_type);

-- 0019: cor do tema escolhida pelo prestador (identidade visual), "#RRGGBB".
-- NULL = segue a cor do segmento (business_type).
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS theme_color varchar(7);

-- Segmento do negócio (decisão multi-segmento, 09/09/2026).
-- beauty é o default: bases existentes (e o nicho inicial) continuam válidas.
ALTER TABLE businesses
	ADD COLUMN IF NOT EXISTS business_type varchar(30) NOT NULL DEFAULT 'beauty';

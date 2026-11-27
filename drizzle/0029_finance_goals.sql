-- 0029: módulo de finanças, Fase 3 — metas mensais de faturamento
-- (.planning/financas/SPEC.md, TASK-F3-02; RF-F10).
-- Uma meta por negócio e mês (month = 1º dia). Idempotente.

CREATE TABLE IF NOT EXISTS financial_goals (
  business_id  uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month        date        NOT NULL CHECK (extract(day FROM month) = 1),
  target_cents integer     NOT NULL CHECK (target_cents > 0),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, month)
);

-- RLS fail-closed (padrão 0008)
ALTER TABLE financial_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_goals FORCE ROW LEVEL SECURITY;

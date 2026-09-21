-- 0008: Row Level Security em TODAS as tabelas (defense-in-depth).
--
-- POR QUÊ: hoje só a API fala com o Postgres (como postgres superuser, que
-- ignora RLS). Mas defesa de uma camada só não é defesa: se qualquer dia uma
-- anon key for exposta, um n8n conectar, ou o dashboard admin usar o REST do
-- Supabase, o banco estaria aberto. Com RLS ativo e nenhuma policy pública,
-- qualquer acesso NÃO-superuser vê ZERO linhas por padrão (fail-closed).
--
-- ESTRATÉGIA:
-- - ENABLE + FORCE ROW LEVEL SECURITY em todas as 12 tabelas.
--   FORCE aplica RLS até pro dono da tabela (o papel da API).
-- - NENHUMA policy criada: a API usa superuser (bypassa RLS), e qualquer
--   acesso futuro precisa declarar policy explícita com revisão. Whitelist
--   implícita, fail-closed.
-- - Colunas de escopo mapeadas (schema.ts, 18/09):
--   businesses (PK própria), users/services/clients/transactions/
--   loyalty_programs/message_templates/subscriptions (business_id),
--   working_hours/device_tokens (user_id), appointments (ambos),
--   loyalty_cards (via program_id → loyalty_programs.business_id — escopo
--   indireto; policy ficaria com EXISTS. Como não criamos policies, fica
--   documentado aqui pra futura policy).
--
-- Segurança da migração: rodar como superuser; FORCE em tabela com only
-- superuser acessando = zero impacto na API.

ALTER TABLE businesses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses        FORCE  ROW LEVEL SECURITY;
ALTER TABLE users             ENABLE ROW LEVEL SECURITY;
ALTER TABLE users             FORCE  ROW LEVEL SECURITY;
ALTER TABLE services          ENABLE ROW LEVEL SECURITY;
ALTER TABLE services          FORCE  ROW LEVEL SECURITY;
ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients           FORCE  ROW LEVEL SECURITY;
ALTER TABLE working_hours     ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_hours     FORCE  ROW LEVEL SECURITY;
ALTER TABLE appointments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments      FORCE  ROW LEVEL SECURITY;
ALTER TABLE transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions      FORCE  ROW LEVEL SECURITY;
ALTER TABLE loyalty_programs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_programs  FORCE  ROW LEVEL SECURITY;
ALTER TABLE loyalty_cards     ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_cards     FORCE  ROW LEVEL SECURITY;
ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates FORCE  ROW LEVEL SECURITY;
ALTER TABLE subscriptions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions     FORCE  ROW LEVEL SECURITY;
ALTER TABLE device_tokens     ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_tokens     FORCE  ROW LEVEL SECURITY;

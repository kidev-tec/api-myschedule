-- 0028: RLS fail-closed na admin_audit_log (SPEC-admin RF-A1/A2/A3/A6).
-- Regra do repo (migration 0008): toda tabela public tem RLS + FORCE.
-- admin_audit_log é append-only: API (dono da tabela) insere via service role;
-- nenhum papel faz SELECT/UPDATE/DELETE por RLS (acesso só via views/endpoints admin).
ALTER TABLE "admin_audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "admin_audit_log" FORCE ROW LEVEL SECURITY;

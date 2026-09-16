# Qualidade — API (TDD + coverage)

## Gate: 100/100/100/100 (statements/branches/functions/lines) no vitest

Config em `vitest.config.ts` (thresholds). Rodar:

    node node_modules/vitest/vitest.mjs run --coverage

## Pirâmide

1. **Unit** (domínio puro — booking/overlaps) — rápidos, sem DB
2. **Integração** (rotas contra Postgres real via `app.request`) — Firebase mockado
3. **E2E manual** no device (fluxo leigo)

## Padrões de teste

- Banco REAL nos testes de rota (postgres docker :5433) — mocks só de serviços externos
- Firebase: `vi.mock('firebase-admin/auth')` com verifyIdToken controlado
- Services externos (FCM, email): mockados — NUNCA chamada real
- Cleanup no afterAll respeitando FKs (appointments → clients → services → users → businesses)
- Fixtures com nome ÚNICO (`${Date.now()}-${seq++}`) — constraint unique name+segment
- Migrations idempotentes: rodar 2x no setup de teste sem erro

## Anti vibe-code

- Sem `it('funciona')` — descrição diz comportamento + critério
- Todo bug corrigido tem teste de regressão primeiro
- `git diff HEAD~1` pós-commit: diff deve corresponder ao intuito
- Status report audível: `grep -rn "not implemented\|TODO\|stub" src/` antes de declarar pronto

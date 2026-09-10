# Contribuindo

## Regra de ouro
PR revisado por Ezequias antes de qualquer merge. Sem exceção.

## Fluxo (feat → staging → main)
1. Branch a partir de `staging`: `feat/<escopo>-<resumo>` ou `fix/<resumo>`
2. TDD obrigatório — coverage mínima **100%** (statements/branches/functions/lines)
3. `npm test && npm run lint` (API) ou `flutter test && flutter analyze` (app) verdes antes do PR
4. PR → `staging`, review do Ezequias, merge
5. `staging` → `main` só com release validado

## Commits
Conventional Commits, assinados (SSH/GPG). Nada de commit direto em `main`/`staging`.

## Coverage
100% é threshold bloqueante, não aspiracional. Exceção de exclusão de arquivo
só em migrations geradas e código de bootstrap de plataforma.

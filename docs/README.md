# Docs agênticas — AGENVA API

Documentação para desenvolvimento com agentes de IA (Hermes, Claude Code, Codex, Cursor).

## skills/

Skills sanitizadas do projeto (sem paths pessoais, sem segredos). *A popular — copiar de `~/.hermes/skills` os domínios do projeto: minha-agenda (API), telegram-monitoring padrão.*

## workflows/

- [sdd.md](sdd.md) — Spec-Driven Development: estrutura de specs, TASK template, RF-ID traceability
- [quality.md](quality.md) — TDD, coverage 100/100/100/100, pirâmide de testes, anti vibe-code

## Regra de ouro

Conteúdo destes docs DEVE vir do código real (verificar com ferramentas), nunca inventado.
Atualizar no mesmo PR que muda o código. Spec divergiu da realidade? Atualiza a spec.

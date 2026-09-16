# Spec-Driven Development (SDD) — guia do repo

Workflow: ESPECIFICAR → revisar spec → implementar com TDD → review.

## Estrutura de specs

    .planning/<feature>/
    ├── README.md          # índice: problema, solução, ordem
    └── specs/TASK-xxx.md  # 1 spec = 1 task = 1 PR

## TASK template (contrato executável)

- **Status:** Draft | Ready | In Progress | Review | Done
- **O QUE É** (1 frase)
- **EXECUTION MODE:** YOLO (bug óbvio) | Interactive (checkpoint em decisões) | Pre-flight (só spec, humano aprova)
- **PRE-CONDITIONS:** o que deve ser verdade ANTES (verificado contra o repo real)
- **O QUE CRIAR:** arquivo(s) + descrição
- **RF-IDs cobertos** (rastreabilidade com a SPEC.md)
- **TESTES DERIVADOS:** dado/quando/então — existem ANTES do código
- **CONTRATO DE SAÍDA:** Zod schema ou type exportado
- **CRITÉRIO DE ACEITE:** max 5 itens testáveis, sem termos vagos
- **POST-CONDITIONS:** verificável por CI/teste
- **ARMADILHAS** conhecidas

## Regras

- Spec vs código real divergiram? Atualiza a spec NO MESMO COMMIT (spec é source of truth).
- Antes de implementar: `grep` pra garantir que não está duplicando coisa existente.
- RF-ID propaga: spec → task → teste (`describe('RF-001')`) → commit → PR body.
- Spec Review Gate bloqueante: sem Execution Mode ou pre-conditions não verificadas = não implementa.
- Regression-first: todo bug corrigido tem o teste de regressão ANTES do fix.

# TASK-F4-01 — Fluxo de caixa projetado (API)

- **Status:** Done
- **O QUE É:** previsão de entradas e saídas dos próximos N dias, dia a dia, com saldo acumulado.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F11
- **Branch:** `feat/financas-projecao-comprovantes` (sobre a F3, que está sobre a F2).

## REGRAS
- Janela: hoje (dia local do negócio) até hoje + `days − 1`; `days` 1–90, padrão 30.
- **Entradas previstas** (por dia do atendimento): saldo a receber (`price − recebido`) de agendamentos `pending`/`confirmed` com início na janela. Bloqueio fora.
- **Saídas previstas** (por dia de vencimento): despesas a pagar (`paid = false`, não anuladas) com `due_at` na janela.
- **Atrasados** (fora da série, informados à parte): a receber de atendimentos já passados (`done`/`pending`/`confirmed` com saldo, início antes de hoje) e despesas a pagar vencidas.
- **Saldo projetado**: acumulado de (entradas − saídas) a partir de 0, dia a dia — o app explica que não inclui o dinheiro que já está em caixa/conta (o Agenva não sabe o saldo bancário).
- Valores no fuso do negócio (`AT TIME ZONE`).

## O QUE CRIAR (`src/routes/finance-cashflow.ts`)
- `GET /v1/finance/cashflow?days=30` →
  `{ from, to, inflow_cents, outflow_cents, net_cents, overdue_in_cents, overdue_out_cents, days: [{ date, inflow_cents, outflow_cents, balance_cents, items: [{ kind: 'appointment'|'expense', id, label, amount_cents }] }] }`
  (`days` traz todos os dias da janela; `items` só onde há movimento).
- `days` inválido → 400 "Período inválido (1 a 90 dias)". OpenAPI.

## TESTES DERIVADOS (`describe('RF-F11')`)
- Agendamento futuro de R$ 100 com sinal de R$ 30 → entrada R$ 70 no dia dele; cancelado/pago/bloqueio fora.
- Despesa a pagar em 5 dias → saída nesse dia; paga/estornada fora.
- Saldo acumulado correto; dias sem movimento = 0 e repetem o saldo.
- Atendimento concluído ontem sem pagamento e despesa vencida ontem → atrasados, fora da série.
- Fuso: agendamento às 23:30 de Brasília cai no dia local.
- `days=0`, `days=91`, `days=x` → 400; isolamento por negócio.

## CRITÉRIO DE ACEITE
1. Projeção bate com agenda e despesas a pagar. 2. Atrasados separados. 3. Cobertura 100%.

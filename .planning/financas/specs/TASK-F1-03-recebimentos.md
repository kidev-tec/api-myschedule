# TASK-F1-03 — Rotas de recebimento, estorno e contas a receber

- **Status:** Done
- **O QUE É:** novo sub-app `src/routes/finance.ts` para lançar recebimentos (sinal, parcial, quitação, avulso), estornar e listar o que está em aberto.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F01, RF-F02, RF-F04

## PRE-CONDITIONS
- TASK-F1-01 e F1-02 concluídas (`domain/payment-status.ts` existe).
- Paywall global em `src/app.ts` já bloqueia POST/PATCH fora de `readOnlyPaths` → `/v1/finance/*` herda sem mudança.
- `grep -rn "finance" src` vazio (não duplicar).

## O QUE CRIAR
- `src/routes/finance.ts`, montado em `app.route("/v1", financeRoutes(...))`; registrar no OpenAPI (`src/openapi.ts`).
- `GET /v1/finance/appointments/:id` → `{ appointment_id, price_cents, paid_cents, balance_cents, payment_status, payments: [{ id, amount_cents, payment_method, installments, kind, occurred_at, notes, voided_at }] }`. 404 se não for do business.
- `POST /v1/finance/payments` — Zod:
  `{ appointment_id?: uuid, client_id?: uuid, amount_cents: int>0, payment_method: enum, installments?: 1..12 (só credit; outro método com >1 → 400), occurred_at?: ISO (padrão now), notes?: ≤500 }`.
  - Com agendamento: `SELECT … FOR UPDATE` no agendamento; cancelado → 422; `amount_cents > saldo` → 422 "Valor maior que o saldo restante (R$ X)". `kind = 'deposit'` se `occurred_at < starts_at` e status `pending|confirmed`; senão `payment`. `client_id` vem do agendamento.
  - Sem agendamento (avulso, D7): `client_id` opcional (se vier, tem de ser do business), `kind = 'payment'`, `category = 'avulso'`.
  - `category = 'atendimento'` quando há agendamento; `type = 'income'`; `created_by_user_id` = usuário.
  - Resposta 201 com o lançamento + situação atualizada do agendamento.
- `POST /v1/finance/transactions/:id/void` → marca `voided_at`; já anulado → 409; outro business → 404.
- `GET /v1/finance/receivables?from&to&client_id` → agendamentos do business com saldo > 0, status `pending|confirmed|done` (cancelado e `noshow` fora — D2), por `starts_at` no período (padrão: sem limite inferior até +60 dias); cada item: id, starts_at, status, client, service, price/paid/balance; e `total_open_cents`, `overdue_cents` (já realizados/passados) e `upcoming_cents` (futuros).

## TESTES DERIVADOS (`describe('RF-F01')`, `('RF-F02')`, `('RF-F04')`)
- Sinal de R$ 30 num agendamento futuro de R$ 100 → 201, `kind=deposit`, situação `partial`, saldo 7000.
- Quitar R$ 70 → `paid`; mais R$ 1 → 422.
- Crédito em 3x → `installments = 3`; Pix com `installments = 2` → 400.
- Dois POST simultâneos de R$ 60 num saldo de R$ 100 → um 201 e um 422.
- Estornar o sinal → volta a `open`; estornar de novo → 409.
- Agendamento cancelado → 422. Agendamento de outro business → 404.
- Avulso sem cliente → 201; com cliente de outro business → 404.
- Receivables: inclui `done` passado com saldo e `confirmed` futuro; exclui cancelado, `noshow`, pago e preço 0; totais conferem.
- Conta vencida (paywall) → POST 402; GET 200.

## CONTRATO DE SAÍDA
Schemas Zod exportados de `finance.ts` (`paymentCreateSchema`, `receivablesQuerySchema`) e tipos de resposta no OpenAPI.

## CRITÉRIO DE ACEITE
1. Nunca é possível receber além do saldo, nem com requisições simultâneas.
2. Estorno remove o valor de todos os cálculos e mantém o registro.
3. "A receber" lista só saldo > 0 de agendamentos ativos/realizados, com totais corretos.
4. Mensagens de erro em PT-BR.
5. Cobertura 100/100/100/100.

## ARMADILHAS
- Isolamento por `business_id` em TODA consulta (inclusive `client_id` e o `:id` do estorno).
- Bloqueios (`source='block'`) nunca aparecem em receivables.

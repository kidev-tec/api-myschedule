# TASK-F2-02 — Despesas (API)

- **Status:** Done
- **O QUE É:** lançar, listar, pagar e estornar despesas, inclusive "a pagar" (data futura).
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F06

## PRE-CONDITIONS
- TASK-F2-01 aplicada. Estorno genérico já existe (`POST /v1/finance/transactions/:id/void`).

## REGRAS
- Categorias fixas (D5): `materiais`, `aluguel`, `taxas`, `energia_agua`, `marketing`, `outros`. **`outros` exige descrição** (`notes`).
- `type = 'expense'`, `kind = 'expense'`.
- **Paga** (`paid = true`, padrão): `occurred_at` = data informada (padrão agora), `payment_method` obrigatório.
- **A pagar** (`paid = false`): `due_at` = vencimento, `occurred_at` = vencimento (só para ordenar), `payment_method` opcional.
- Pagar uma despesa a pagar: `paid = true`, `occurred_at` = data do pagamento (padrão agora), `payment_method` obrigatório.
- Despesa paga **em dinheiro com o caixa aberto** entra no caixa (`cash_session_id`) — ver TASK-F2-03.

## O QUE CRIAR (em `src/routes/finance.ts` ou `finance-expenses.ts`)
- `POST /v1/finance/expenses` — `{ amount_cents, category, paid?, date?, payment_method?, notes? }` → 201 `{ expense }`.
- `POST /v1/finance/expenses/:id/pay` — `{ payment_method, date? }` → 200; já paga → 409; estornada → 409.
- `GET /v1/finance/expenses?from&to&category&status=paid|pending` → `{ items, paid_cents, pending_cents, overdue_cents }`. Período filtra por `occurred_at` (pagas) e `due_at` (a pagar). Estornadas aparecem com `voided_at` e não somam.
- OpenAPI (tag Finanças).

## TESTES DERIVADOS (`describe('RF-F06')`)
- Despesa paga em Pix → 201, soma em `paid_cents`.
- A pagar com vencimento em 10 dias → `pending_cents`; vencida (ontem, não paga) → também em `overdue_cents`.
- Pagar a pagar → vira paga com a data do pagamento; pagar de novo → 409.
- `outros` sem descrição → 400 "Descreva a despesa"; categoria inválida → 400; paga sem forma → 400.
- Estornada não soma; outro negócio → 404; conta vencida → 402 no POST.

## CRITÉRIO DE ACEITE
1. Pagas e a pagar separadas nos totais. 2. Mensagens PT-BR. 3. Isolamento por negócio. 4. Cobertura 100%.

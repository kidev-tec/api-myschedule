# TASK-F2-03 — Caixa diário (API)

- **Status:** Done
- **O QUE É:** abrir o caixa com saldo inicial, registrar suprimento/sangria, fechar com o valor contado e guardar a diferença.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F05

## PRE-CONDITIONS
- TASK-F2-01 e F2-02 concluídas.

## REGRAS
- No máximo 1 caixa aberto por negócio. Usar finanças **não exige** caixa aberto.
- Com o caixa aberto, **todo** lançamento novo do negócio (recebimento, despesa paga, suprimento, sangria) recebe `cash_session_id`.
- O caixa confere **só dinheiro em espécie**:
  `esperado = saldo inicial + entradas em dinheiro − saídas em dinheiro` (não anuladas).
  - entradas em dinheiro: recebimentos `cash` + suprimentos (`kind = cash_in`);
  - saídas em dinheiro: despesas pagas `cash` + sangrias (`kind = cash_out`).
- Suprimento/sangria não são receita nem despesa: ficam fora de faturamento e despesas (relatórios da F3 excluem `cash_in`/`cash_out`).
- Fechar: grava `counted_cents`, `expected_cents` (congelado), `closed_at`, `closed_by`. Diferença = contado − esperado (positivo = sobra, negativo = falta).
- Sangria maior que o esperado no momento → 422 "Não há dinheiro suficiente no caixa".
- O resumo mostra também o total recebido no caixa por forma (Pix, cartão…), só informativo.

## O QUE CRIAR
- `GET /v1/finance/cash/current` → `{ session: null }` ou `{ session: { id, opened_at, opening_cents, cash_in_cents, cash_out_cents, expected_cents, by_method: {pix: n, ...}, movements: [...] } }`.
- `POST /v1/finance/cash/open` `{ opening_cents }` → 201; já aberto → 409 "O caixa já está aberto".
- `POST /v1/finance/cash/movements` `{ direction: 'in'|'out', amount_cents, notes? }` → 201; sem caixa aberto → 409 "Abra o caixa primeiro".
- `POST /v1/finance/cash/close` `{ counted_cents, notes? }` → 200 `{ session: {..., expected_cents, counted_cents, difference_cents} }`; sem caixa aberto → 409.
- `GET /v1/finance/cash?from&to` → caixas fechados no período com diferença.
- `POST /v1/finance/payments` e despesas pagas passam a gravar `cash_session_id` quando há caixa aberto.

## TESTES DERIVADOS (`describe('RF-F05')`)
- Abrir com R$ 50; receber R$ 100 em dinheiro e R$ 80 em Pix; suprimento R$ 20; despesa R$ 30 em dinheiro; sangria R$ 40 → esperado R$ 100; `by_method` mostra Pix R$ 80.
- Fechar contando R$ 95 → diferença −R$ 5 (falta); caixa some do `current`; aparece no histórico.
- Recebimento estornado sai do esperado.
- 2º `open` → 409; `movements`/`close` sem caixa → 409; sangria acima do esperado → 422.
- Dois `open` simultâneos → um 201, um 409 (índice único).
- Lançamento sem caixa aberto fica com `cash_session_id` nulo.

## CRITÉRIO DE ACEITE
1. Esperado bate com o dinheiro movimentado. 2. Diferença registrada no fechamento. 3. Caixa opcional. 4. Cobertura 100%.

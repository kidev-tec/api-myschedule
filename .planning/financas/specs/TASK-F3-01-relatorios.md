# TASK-F3-01 — Relatórios: faturamento, por serviço e ticket médio (API)

- **Status:** Done
- **O QUE É:** resumo financeiro de um período (dia, semana, mês ou livre) e faturamento por serviço.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F07, RF-F08, RF-F09
- **Branch:** `feat/financas-relatorios` (sobre a Fase 2, PRs api#61 / apk#86 abertos).

## PRE-CONDITIONS (verificadas em 2026-11-27)
- Livro-caixa em `transactions` (F1/F2); `kind` distingue payment/deposit/expense/cash_in/cash_out.
- `businesses.timezone`; `domain/schedule-day.ts` tem `dayKey(d, tz)`.
- Sem biblioteca de datas no projeto (e nova dependência é decisão bloqueada): limites de dia via SQL `(<ts> AT TIME ZONE tz)::date`.

## REGRAS
- **Período em datas locais do negócio** (`from`/`to` = `YYYY-MM-DD`, inclusivos). O app calcula dia/semana (seg–dom)/mês; a API converte com `AT TIME ZONE businesses.timezone`. Período máximo: 366 dias.
- **Faturamento = regime de caixa (D1):** soma dos recebimentos (`type=income`, `kind IN (payment, deposit)`, não anulados) com `occurred_at` no período. Suprimento/sangria nunca entram.
- **Despesas:** `kind = expense`, `paid = true`, não anuladas, `occurred_at` no período.
- **Resultado** = faturamento − despesas.
- **Por forma de pagamento:** faturamento agrupado por `payment_method`.
- **Série diária:** faturamento e despesas por dia local (para o gráfico de barras do app).
- **Por serviço (D4 + D10):** atendimentos **concluídos** (`status = done`) com início no período, agrupados por serviço: quantidade e soma de `price_cents` (valor vendido). Kit conta como o kit.
- **Ticket médio (D10):** sobre os mesmos atendimentos concluídos — por atendimento = soma ÷ quantidade; por cliente = soma ÷ clientes distintos. Sem atendimentos → 0.
- **Em aberto:** total atual de "A receber" (mesma regra de `/finance/receivables`, sem período).

## O QUE CRIAR (`src/routes/finance-reports.ts`)
- `GET /v1/finance/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` →
  `{ from, to, revenue_cents, expenses_cents, result_cents, by_method, series: [{date, revenue_cents, expenses_cents}], done_count, sold_cents, avg_ticket_cents, avg_per_client_cents, open_cents }`
- `GET /v1/finance/reports/services?from&to` → `{ items: [{ service_id, service_name, is_kit, count, total_cents }] }` ordenado por `total_cents` desc.
- Datas inválidas, `from > to` ou período > 366 dias → 400 em PT-BR.
- OpenAPI (tag Finanças).

## TESTES DERIVADOS (`describe('RF-F07' | 'RF-F08' | 'RF-F09')`)
- Recebimento às 23:30 de Brasília (02:30 UTC do dia seguinte) conta no dia local certo.
- Sinal + quitação somam; estornado, suprimento e sangria não; despesa a pagar não; despesa paga sim.
- Série tem um item por dia do período (dias sem movimento = 0).
- Por serviço: 2 cortes concluídos (R$ 50 e R$ 40 com desconto) + 1 kit → itens corretos; cancelado/pendente fora.
- Ticket: 3 atendimentos, 2 clientes, R$ 150 → por atendimento R$ 50, por cliente R$ 75.
- Isolamento por negócio; `from` inválido / invertido / > 366 dias → 400.

## CRITÉRIO DE ACEITE
1. Limites de dia no fuso do negócio. 2. Números batem com o livro-caixa. 3. Cobertura 100%.

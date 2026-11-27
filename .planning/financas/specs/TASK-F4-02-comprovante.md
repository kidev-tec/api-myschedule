# TASK-F4-02 — Comprovante de recebimento (API)

- **Status:** Done
- **O QUE É:** dados de um comprovante simples de recebimento, com número sequencial por negócio.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F12

## REGRAS (D8: o app gera a imagem; a API só dá os dados)
- Só recebimentos (`type = income`, `kind IN (payment, deposit)`) **não estornados**. Estornado → 409 "Recebimento estornado não gera comprovante".
- **Número sequencial por negócio**, atribuído na 1ª vez que o comprovante é pedido e fixo depois (pedir de novo devolve o mesmo número). Concorrência: atribuição travando o negócio (`SELECT … FOR UPDATE` em `businesses`) + índice único.
- Conteúdo: número, data/hora do recebimento, valor, forma (+ parcelas), "Sinal" quando `deposit`; negócio (nome, endereço se houver, URL do logo se houver); cliente (nome); atendimento (serviço, data/hora, valor total, total recebido, saldo) quando houver.
- **Não** traz telefone/e-mail do cliente (o comprovante é compartilhado).

## O QUE CRIAR
- `drizzle/0030_finance_receipts.sql`: `transactions.receipt_number integer` + `UNIQUE (business_id, receipt_number)` (índice parcial `WHERE receipt_number IS NOT NULL`).
- `schema.ts`.
- `GET /v1/finance/transactions/:id/receipt` → `{ number, payment: {...}, business: {...}, client: {name} | null, appointment: {...} | null }`.
  GET mas atribui o número: é idempotente (mesmo resultado nas chamadas seguintes) e não passa pelo paywall de escrita (consultar comprovante continua com a conta vencida).
- OpenAPI.

## TESTES DERIVADOS (`describe('RF-F12')`)
- 1º comprovante do negócio = 1; 2º recebimento = 2; pedir o 1º de novo = 1.
- Dois pedidos simultâneos de recebimentos diferentes → números diferentes (1 e 2).
- Negócios diferentes têm sequências próprias.
- Sinal mostra `kind = deposit`; avulso sem cliente/atendimento → `client`/`appointment` null.
- Estornado → 409; despesa/suprimento → 404; outro negócio → 404; id inválido → 400.
- Migration 2x.

## CRITÉRIO DE ACEITE
1. Número estável e único por negócio. 2. Sem dado de contato do cliente. 3. Cobertura 100%.

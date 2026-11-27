# TASK-F1-01 — Migration 0027: preço no agendamento + livro-caixa

- **Status:** Ready
- **O QUE É:** migration idempotente que grava o valor do atendimento em `appointments` e estende `transactions` para registrar recebimentos.
- **EXECUTION MODE:** Interactive (checkpoint: rodar 2x no banco local antes de seguir)
- **RF-IDs:** RF-F01, RF-F02, RF-F03 (base de dados)

## PRE-CONDITIONS (verificadas em 2026-11-27)
- Última migration é `drizzle/0026_aggregator.sql`.
- `appointments` não tem coluna de preço; `services.price_cents integer NOT NULL`.
- `transactions` existe (`0000_init`) e não é usada por nenhuma rota (só o reset em `auth-sync.ts`).
- Teste de migration segue o padrão de `test/migrations/client-origin.test.ts` (roda o SQL real 2x).

## O QUE CRIAR
- `drizzle/0027_finance_payments.sql`:
  - `appointments.price_cents integer` → backfill `UPDATE … SET price_cents = s.price_cents FROM services s WHERE … AND a.price_cents IS NULL` → `SET DEFAULT 0`, `SET NOT NULL`. Bloqueios (`source='block'`) = 0.
  - `transactions`: `payment_method varchar(20)`, `installments integer NOT NULL DEFAULT 1`, `kind varchar(20) NOT NULL DEFAULT 'payment'`, `client_id uuid REFERENCES clients(id)`, `created_by_user_id uuid REFERENCES users(id)`, `voided_at timestamptz`, `created_at timestamptz NOT NULL DEFAULT now()`.
  - Constraints (via `DO $$ … IF NOT EXISTS`): `amount_cents > 0`; `installments BETWEEN 1 AND 12`; `payment_method IN (pix,cash,debit,credit,payment_link,other)`; `kind IN (payment,deposit,expense,cash_in,cash_out)`.
  - `CREATE INDEX IF NOT EXISTS transactions_appointment_idx ON transactions(appointment_id) WHERE voided_at IS NULL`.
- `src/db/schema.ts`: colunas novas em `appointments` e `transactions`.
- `test/migrations/finance-payments.test.ts`.

> Colunas de caixa, despesas a pagar, comprovante e as tabelas `cash_sessions` / `financial_goals` ficam para as migrations das fases F2–F4 (cada fase traz só o que usa).

## TESTES DERIVADOS
- Dado agendamento de serviço R$ 80 sem preço → quando a migration roda → então `price_cents = 8000`.
- Dado bloqueio → então `price_cents = 0`.
- Dado a migration já aplicada → quando roda de novo → então não dá erro e não altera `price_cents` editado depois.
- Dado `transactions` → quando insere `amount_cents = 0` ou `payment_method = 'boleto'` → então viola constraint.

## CRITÉRIO DE ACEITE
1. Migration roda 2x sem erro no Postgres local (5433).
2. Nenhum agendamento fica com `price_cents` NULL.
3. Constraints rejeitam valor ≤ 0, parcelas fora de 1–12, forma/tipo inválidos.
4. Suíte inteira verde, cobertura 100/100/100/100.

## POST-CONDITIONS
- `npm run db:migrate` aplica 0027; `tsc` e `biome` limpos.

## ARMADILHAS
- `ALTER … SET NOT NULL` só depois do backfill, na mesma migration.
- Não usar `ADD CONSTRAINT` direto (não é idempotente) — envolver em `DO $$`.

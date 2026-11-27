# TASK-F1-02 — Valor e situação de pagamento no agendamento

- **Status:** Ready
- **O QUE É:** gravar o preço ao criar/remarcar, permitir editar o valor e expor recebido/saldo/situação na agenda.
- **EXECUTION MODE:** Interactive
- **RF-IDs:** RF-F02 (situação), RF-F03

## PRE-CONDITIONS (verificadas em 2026-11-27)
- TASK-F1-01 aplicada.
- Inserts de `appointments`: `src/routes/appointments.ts` (POST `/` ~l.489 e remarcação ~l.828) e `src/routes/public-booking.ts` (~l.386).
- **Remarcar cria NOVA linha** e cancela a original (BARRA B5, `appointments.ts` ~l.797).
- `GET /appointments` já devolve `service_price_cents` (preço de tabela atual).

## O QUE CRIAR
- `src/domain/payment-status.ts` (puro):
  `paymentStatus(priceCents, paidCents) → { paid_cents, balance_cents, payment_status: 'none'|'open'|'partial'|'paid' }`
  (`none` = preço 0; `paid` = saldo ≤ 0).
- Criação (app e link público): `price_cents` = `services.price_cents` do serviço/kit escolhido; bloqueio = 0.
- Remarcação: nova linha herda `price_cents` da original **e os recebimentos não anulados são movidos** (`UPDATE transactions SET appointment_id = <nova>`), na mesma transação.
- `PATCH /v1/appointments/:id` aceita `price_cents` (inteiro ≥ 0, opcional). 422 em PT-BR se a situação for `paid` ou se o novo valor ficar menor que o já recebido.
- `GET /v1/appointments`: acrescenta `price_cents`, `paid_cents`, `balance_cents`, `payment_status` (soma por subquery/left join agregado — sem N+1). `service_price_cents` continua (contrato aditivo).

## TESTES DERIVADOS
- `describe('RF-F03')`: criar agendamento de serviço R$ 50 → `price_cents = 5000`; mudar o preço do serviço depois → agendamento continua 5000.
- Link público grava `price_cents`; bloqueio grava 0.
- PATCH `price_cents: 4000` → 200; PATCH num agendamento pago → 422; PATCH abaixo do recebido → 422; PATCH `-1` → 400.
- Remarcar agendamento com sinal de R$ 20 → nova linha com `paid_cents = 2000`, original sem recebimentos.
- `paymentStatus`: (0,0)=none, (5000,0)=open, (5000,2000)=partial, (5000,5000)=paid.
- `GET /appointments` traz os 4 campos novos; recebimento anulado não soma.

## CONTRATO DE SAÍDA
```ts
type AppointmentFinance = { price_cents: number; paid_cents: number; balance_cents: number; payment_status: 'none'|'open'|'partial'|'paid' };
```

## CRITÉRIO DE ACEITE
1. Preço de tabela alterado não muda agendamentos existentes.
2. Remarcar não perde recebimentos.
3. PATCH só aceita valor ≥ recebido e não altera agendamento pago.
4. Agenda devolve situação sem chamada extra por item.
5. Cobertura 100/100/100/100.

## ARMADILHAS
- Kit oculto (`adhoc`): usar o `price_cents` do serviço-kit criado para o agendamento.
- Contrato aditivo — não remover nem renomear campos (app e link público dependem).

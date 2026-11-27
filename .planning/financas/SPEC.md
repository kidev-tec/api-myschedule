# SPEC — Módulo de Finanças (Etapa 2 | Gestão financeira)

Data: 2026-11-27 · Autor: Ezequias + Claude · Estado: **APROVADA (Ezequias, 2026-11-27)** — decisões da §9 fechadas
Branch: `feat/modulo-financas` (api e apk), base `staging`.
Fonte: `AGENVA_Projeto.pdf`, pág. 5 — "Etapa 2 | Gestão financeira".

## 0. Objetivo e princípio

Conectar a rotina de atendimentos à realidade financeira do negócio: acompanhar o
dinheiro que entra e sai, identificar receitas em aberto e dar ao gestor uma visão
objetiva da saúde financeira.

**Princípio:** o módulo é **aditivo**. Quem não usar finanças continua com a agenda
exatamente como hoje — nenhum campo novo é obrigatório para agendar, e nenhum fluxo
atual muda de comportamento.

## 1. Como o sistema é hoje (o que importa para o módulo)

| Ponto | Situação atual | Impacto |
|---|---|---|
| Preço | `services.price_cents` (inteiro, centavos). Kits (`is_kit`) e kit oculto (`adhoc`) também são `services`. | Preço de tabela existe; é a base do valor cobrado. |
| Agendamento | `appointments` **não guarda preço**. Status `pending/confirmed/done/canceled/noshow`. Bloqueio usa serviço arquivado com preço 0. | Se o preço do serviço mudar, o histórico muda junto → precisa de **snapshot do preço** no agendamento. |
| `transactions` | Tabela existe desde `0000_init` (`type income/expense`, `amount_cents`, `category`, `appointment_id`, `occurred_at`, `notes`), **sem nenhuma rota usando** (só é apagada no reset de conta em `auth-sync.ts`). | Pode virar o **livro-caixa** do módulo, estendida por migration. |
| Agregador | Agendamento via agregador é gravado **no business do profissional** (`aggregator_business_id` registra a origem). | A receita é do profissional. Visão do agregador fica fora do MVP (§9). |
| Fuso | `businesses.timezone`. | "Dia", "semana" e "mês" dos relatórios usam o fuso do business, não UTC. |
| Paywall | Escrita bloqueada com trial/assinatura vencidos (402). | Lançamentos financeiros são escrita → seguem o paywall. |
| Asaas | Usado **só** para a assinatura do próprio Agenva (`billing.ts`, `asaas-webhook.ts`). | Checkout para os clientes do profissional é outro assunto (Fase 5). |
| App | Rotas em `lib/main.dart` (GoRouter), sem aba de finanças. Features em `lib/features/*`. | Nova feature `lib/features/finance/`. |

## 2. Decisão central de modelagem

1. **Dinheiro sempre em centavos (`integer`)**, igual ao resto do sistema. Nunca `float`.
2. **Snapshot de preço**: `appointments.price_cents` gravado na criação (preço do
   serviço/kit naquele momento), editável pelo profissional (desconto/acréscimo).
   Backfill dos agendamentos existentes com o preço atual do serviço.
3. **`transactions` é o livro-caixa único**: todo recebimento (sinal, parcial,
   quitação, avulso) e toda despesa é uma linha. Relatórios, caixa e metas são
   **consultas** sobre ele — não há saldo gravado que possa divergir.
4. **Situação da cobrança é derivada**, nunca gravada:
   `recebido = soma(income ativos do agendamento)`;
   `saldo = price_cents − recebido` → `sem cobrança` (preço 0) | `em aberto` |
   `parcial` | `pago` (saldo ≤ 0).
5. **Estorno, não exclusão**: lançamento errado é anulado (`voided_at`), mantendo o
   histórico e a conferência do caixa honesta.

## 3. Modelo de dados (visão completa, idempotente)

> Entregue **por fase**: cada fase traz só as colunas/tabelas que usa
> (F1 = `0027_finance_payments.sql`: `appointments.price_cents` + colunas de recebimento em `transactions`).

```sql
-- snapshot do valor cobrado no atendimento
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS price_cents integer;   -- backfill = services.price_cents
-- (NOT NULL DEFAULT 0 após o backfill)

-- livro-caixa: estende a tabela existente
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method varchar(20);  -- pix|cash|debit|credit|payment_link|other (NULL em despesa sem forma)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installments   integer NOT NULL DEFAULT 1; -- parcelamento (informativo, ver §9)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS kind           varchar(20) NOT NULL DEFAULT 'payment'; -- payment|deposit|expense|cash_in|cash_out
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_id      uuid REFERENCES clients(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS cash_session_id uuid;          -- FK para cash_sessions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS due_at         timestamptz;    -- despesa a pagar (futura)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS paid           boolean NOT NULL DEFAULT true;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_by_user_id uuid REFERENCES users(id);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS voided_at      timestamptz;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_number integer;        -- sequencial por business (comprovante)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS created_at     timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS transactions_appointment_idx ON transactions(appointment_id);
CHECK (amount_cents > 0)

-- caixa diário
CREATE TABLE IF NOT EXISTS cash_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  opened_by       uuid NOT NULL REFERENCES users(id),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  opening_cents   integer NOT NULL DEFAULT 0,      -- saldo inicial (troco)
  closed_at       timestamptz,
  counted_cents   integer,                          -- valor contado no fechamento
  expected_cents  integer,                          -- calculado no fechamento (congelado)
  notes           text
);
-- no máximo 1 caixa aberto por business
CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_idx ON cash_sessions(business_id) WHERE closed_at IS NULL;

-- metas
CREATE TABLE IF NOT EXISTS financial_goals (
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  month         date NOT NULL,                     -- 1º dia do mês
  target_cents  integer NOT NULL CHECK (target_cents > 0),
  PRIMARY KEY (business_id, month)
);

-- categorias de despesa (padrões + do usuário)
-- padrões fixos no código: materiais, aluguel, taxas, energia_agua, marketing, outros
-- personalizadas: tabela expense_categories (business_id, name) — ver §9
```

Reset de conta (`auth-sync.ts`) passa a apagar também `cash_sessions` e `financial_goals`.

## 4. Requisitos funcionais (RF-F)

| RF | Funcionalidade (doc) | Regra |
|---|---|---|
| **RF-F01** | Formas de pagamento | Pix, dinheiro, débito, crédito, link de pagamento, outros. Crédito aceita nº de parcelas (1–12). |
| **RF-F02** | Pagamento parcial / sinal | Vários recebimentos por agendamento. O 1º antes do atendimento é marcado `deposit` (sinal). Mostra recebido, saldo restante e situação (§2.4). Recebimento acima do saldo → 422 (sem troco/crédito no MVP). |
| **RF-F03** | Valor do atendimento | `price_cents` gravado ao criar; editável (desconto/acréscimo) enquanto não estiver `pago`. Bloqueio = 0 e fica fora de tudo. |
| **RF-F04** | Contas a receber | Lista agendamentos com saldo > 0: já realizados (`done`, vencidos) e futuros (`pending/confirmed`). Cancelados ficam fora; `noshow` ver §9. Filtro por período e cliente; total em aberto. |
| **RF-F05** | Caixa diário | Abrir (saldo inicial), lançar entradas/saídas, fechar com valor contado. Esperado = inicial + entradas em dinheiro − saídas em dinheiro. Diferença (sobra/falta) registrada. Lançamentos com o caixa aberto se ligam a ele. Usar finanças **não exige** caixa aberto. |
| **RF-F06** | Controle de despesas | Lançar despesa (valor, categoria, data, forma, obs.). Despesa com data futura = **a pagar** (`paid=false`), entra no fluxo projetado; marcar como paga. |
| **RF-F07** | Relatório de faturamento | Dia / semana / mês / período livre. Totais: recebido, despesas, resultado, em aberto. Por forma de pagamento. |
| **RF-F08** | Faturamento por serviço | Por serviço: quantidade de atendimentos `done` e receita. Kits: ver §9. |
| **RF-F09** | Ticket médio | Por atendimento (receita ÷ atendimentos `done`) e por cliente (receita ÷ clientes distintos) no período. |
| **RF-F10** | Metas financeiras | Meta mensal; mostra realizado e % atingido (base: recebido no mês). |
| **RF-F11** | Fluxo de caixa projetado | Próximos N dias (padrão 30): saldo atual + saldos a receber de agendamentos futuros (pela data do atendimento) − despesas a pagar (pela data de vencimento). |
| **RF-F12** | Comprovantes e recibos | Comprovante simples de um recebimento (nº sequencial, negócio, cliente, serviço, valor, forma, data). Compartilhar pelo app (WhatsApp/sistema). |
| **RF-F13** | Integração / checkout | Fora do MVP — depende da escolha do prestador (doc: "ainda deverão ser definidas e homologadas"). |

## 5. API (todas autenticadas, escrita sujeita ao paywall)

```
GET    /v1/finance/appointments/:id          → valor, recebimentos, recebido, saldo, situação
PATCH  /v1/appointments/:id                  → aceita price_cents (RF-F03)
POST   /v1/finance/payments                  → { appointment_id?, client_id?, amount_cents, payment_method, installments?, occurred_at?, notes? }
POST   /v1/finance/transactions/:id/void     → estorno
GET    /v1/finance/receivables?from&to&client_id
POST   /v1/finance/expenses  · PATCH /:id (marcar paga) · GET ?from&to&category
GET    /v1/finance/cash/current · POST /v1/finance/cash/open · POST /v1/finance/cash/close · GET /v1/finance/cash?from&to
GET    /v1/finance/reports/summary?from&to   → faturamento, por forma, despesas, resultado, ticket médio
GET    /v1/finance/reports/services?from&to
GET    /v1/finance/goals/:month · PUT /v1/finance/goals/:month
GET    /v1/finance/cashflow?days=30
GET    /v1/finance/transactions/:id/receipt  → dados do comprovante (app monta e compartilha)
```

A listagem da agenda (`GET /appointments`) ganha `price_cents`, `paid_cents` e
`payment_status` para mostrar a situação sem chamada extra.

## 6. App (Flutter) — `lib/features/finance/`

- **Agendamento (detalhe/ações):** bloco "Pagamento" com valor, recebido, saldo e chip
  de situação; botão **Receber** (valor, forma, parcelas) e **Comprovante**.
- **Agenda do dia:** ícone/chip discreto de situação de pagamento no card.
- **Nova entrada no menu: "Finanças"** → tela inicial com resumo do mês (recebido,
  despesas, resultado, meta %), atalhos: Caixa do dia, A receber, Despesas,
  Relatórios, Fluxo projetado.
- Valores digitados com máscara R$ e convertidos para centavos.

## 7. Fases de entrega (TDD em cada uma; 1 fase = 1 PR por repo)

| # | Fase | RFs | Pronto quando |
|---|---|---|---|
| F1 | Cobrança do atendimento | F01, F02, F03, F04 | Recebo sinal + saldo de um agendamento, vejo a situação na agenda e a lista "A receber". |
| F2 | Caixa e despesas | F05, F06 | Abro o caixa, recebo em dinheiro, lanço despesa, fecho e vejo a diferença. |
| F3 | Relatórios e metas | F07, F08, F09, F10 | Tela Finanças mostra faturamento do período, por serviço, ticket médio e % da meta. |
| F4 | Projeção e comprovantes | F11, F12 | Vejo o fluxo dos próximos 30 dias e compartilho um comprovante. |
| F5 | Checkout (futuro) | F13 | Depois da escolha do prestador — SPEC própria. |

Cada fase gera `specs/TASK-xxx.md` (template de `docs/workflows/sdd.md`) antes de codar.
Na branch única `feat/modulo-financas`, cada TASK vira um commit; a fase fecha com 1 PR por repo.

### Tasks da F1
| Task | Repo | Arquivo |
|---|---|---|
| F1-01 Migration 0027 | api | `specs/TASK-F1-01-migration.md` |
| F1-02 Valor e situação no agendamento | api | `specs/TASK-F1-02-preco-agendamento.md` |
| F1-03 Recebimentos, estorno, a receber | api | `specs/TASK-F1-03-recebimentos.md` |
| F1-11 Pagamento no agendamento | apk | `apk/.planning/financas/specs/TASK-F1-11-pagamento-agendamento.md` |
| F1-12 Área Finanças + A receber | apk | `apk/.planning/financas/specs/TASK-F1-12-a-receber.md` |

F1 concluída: kidev-tec/api-myschedule#60 e kidev-tec/apk-myschedule#85 (merge em staging, 2026-11-27).

### Tasks da F2
| Task | Repo | Arquivo |
|---|---|---|
| F2-01 Migration 0028 (caixa, despesas) | api | `specs/TASK-F2-01-migration.md` |
| F2-02 Despesas | api | `specs/TASK-F2-02-despesas.md` |
| F2-03 Caixa diário | api | `specs/TASK-F2-03-caixa.md` |
| F2-11 Despesas | apk | `apk/.planning/financas/specs/TASK-F2-11-despesas.md` |
| F2-12 Caixa do dia | apk | `apk/.planning/financas/specs/TASK-F2-12-caixa.md` |

## 8. Pontos de atenção

- **Cobertura api 100/100/100/100**; apk ≥ gate vigente.
- Limites de dia/mês no **fuso do business** (testes com virada de dia em UTC).
- Concorrência: dois recebimentos simultâneos não podem ultrapassar o saldo
  (transação + `SELECT … FOR UPDATE` no agendamento).
- Somente o dono do business vê/lança (rotas filtram por `business_id` do token).
- Lançamentos anulados ficam fora de todos os totais.
- Agendamento cancelado com sinal recebido: o sinal continua no caixa até ser estornado
  manualmente (devolução é decisão do profissional).

## 9. Decisões (aprovadas em 2026-11-27 — NÃO re-decidir)

| # | Pergunta | Decisão |
|---|---|---|
| D1 | Relatórios por **regime de caixa** (data do recebimento) ou **competência** (data do atendimento)? | Faturamento = caixa (o que entrou). "Em aberto" à parte. |
| D2 | `noshow` entra em "A receber"? | Não por padrão; se houver sinal, fica retido. |
| D3 | Parcelamento no crédito: só informativo (entra tudo na data) ou gera parcelas futuras no fluxo projetado? | Informativo no MVP (maquininha já antecipa/repassa). |
| D4 | Kit no "faturamento por serviço": conta como o kit ou rateia entre os serviços do kit? | Conta como o kit. |
| D5 | Categorias de despesa: só fixas ou o usuário cria as suas? | Fixas + "outros" com descrição no MVP; personalizadas depois. |
| D6 | Agregador vê o faturamento dos agendamentos vindos do seu link? | Fora do MVP. |
| D7 | Recebimento avulso (sem agendamento, ex.: venda de produto)? | Sim, com cliente opcional. |
| D8 | Comprovante: texto compartilhável ou PDF/imagem? | Imagem/PDF simples gerado no app. |
| D9 | Ordem das fases (§7) está boa? | F1 → F4 nessa ordem. |

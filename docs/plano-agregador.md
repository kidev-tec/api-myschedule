# Plano — Módulo Agregador de Profissionais

> Branch: `feat/novo-modulo` (api e apk), base `staging`.
> Status: **aprovado em 2026-11-06** — decisões registradas na seção 9.

## 0. Princípio

**O Agenva continua funcionando exatamente como hoje para o profissional independente.** O agregador é uma possibilidade **a mais**, não uma substituição:

- todas as contas existentes viram `independent` automaticamente e não percebem mudança nenhuma;
- no cadastro, *Profissional independente* é a opção padrão; o fluxo dele (serviços, horários, agenda, link próprio) fica igual;
- o link público de quem é independente continua idêntico;
- tudo o que é novo (códigos, vínculos, seletor de profissional) só aparece para quem usa.

## 1. Como o sistema é hoje (o que importa para o módulo)

| Ponto | Situação atual | Impacto |
|---|---|---|
| Conta | `POST /auth/sync` cria **1 user (owner) + 1 business** por login. "1 profissional = 1 business". | Toda conta já é um "profissional independente" com negócio próprio. |
| Dados por negócio | `services`, `clients`, `appointments` têm `business_id`. `working_hours` e `time_offs` são por `user_id`. | A agenda do profissional mora no business dele. |
| Conflito de horário | Índice `appointments_no_overlap_idx` em `(business_id, user_id, tstzrange)`. | Só impede choque **dentro do mesmo business**. |
| Link público | `/p/:slug` → `loadBySlug` pega o **primeiro user** do business. `info`, `busy`, `book` trabalham com esse único profissional. | É aqui que entra o seletor de profissional. |
| `users.role` | Enum `owner/pro/reception` já existe, mas só `owner` é usado. | Não vamos usar para este módulo (ver §2). |
| Notificações | Tabela `notifications` + `notify()` (sino + push), tipos livres (`new_booking`, `waitlist`…). | Base pronta para os avisos de aprovação. |
| Paywall | Escrita bloqueada quando trial/assinatura vence; `book` público responde 402. | Precisa decidir quem "paga" no agendamento via agregador. |

## 2. Decisão central de modelagem

**O profissional continua dono da própria agenda.** O agregador **não copia** o profissional para dentro do seu business; ele cria um **vínculo** (`professional_links`) entre as duas contas.

Quando um cliente agenda pelo link do agregador escolhendo o profissional X:

- o agendamento é gravado **no business do profissional X** (`business_id` = do profissional, `user_id` = profissional);
- uma coluna nova `appointments.aggregator_business_id` registra **por qual agregador** veio;
- o cliente é criado/encontrado **na base de clientes do profissional**.

**Por quê:** um profissional pode estar em vários agregadores e ainda ter o link próprio. Se cada agregador tivesse uma cópia da agenda, o índice anti-conflito (que é por business) deixaria marcar o mesmo horário duas vezes em lugares diferentes. Com a agenda única no business do profissional, o índice que já existe continua garantindo "zero conflito" sem mudar nada no núcleo.

## 3. Modelo de dados (migration `0026_aggregator.sql`, idempotente)

```sql
-- tipo da conta
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS account_kind varchar(20) NOT NULL DEFAULT 'independent'; -- 'independent' | 'aggregator'
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS aggregator_code varchar(12) UNIQUE;  -- gerado ao virar agregador
ALTER TABLE users      ADD COLUMN IF NOT EXISTS pro_code        varchar(12) UNIQUE;  -- todo profissional tem (backfill)

-- vínculo agregador ↔ profissional
CREATE TABLE IF NOT EXISTS professional_links (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregator_business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  professional_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        varchar(20) NOT NULL DEFAULT 'pending', -- pending | active | rejected | canceled | ended
  requested_by  varchar(20) NOT NULL,                   -- 'professional' | 'aggregator'
  show_on_link  boolean NOT NULL DEFAULT true,          -- aparece no seletor do link público
  position      integer NOT NULL DEFAULT 0,             -- ordem no seletor
  created_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz,
  ended_at      timestamptz
);
-- no máximo 1 vínculo vivo (pendente ou ativo) por par
CREATE UNIQUE INDEX IF NOT EXISTS professional_links_live_uq
  ON professional_links (aggregator_business_id, professional_user_id)
  WHERE status IN ('pending','active');
ALTER TABLE professional_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_links FORCE  ROW LEVEL SECURITY;

-- origem do agendamento
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS aggregator_business_id uuid REFERENCES businesses(id) ON DELETE SET NULL;
```

- **Códigos:** 8 caracteres, alfabeto sem ambíguos (sem 0/O/1/I/L), com prefixo visual: `P-7K3M9QXT` (profissional) e `E-4HWN2RBC` (estabelecimento). Gerados no servidor com retry em colisão. Backfill do `pro_code` para todos os users existentes na própria migration.
- **Histórico:** vínculos não são apagados — mudam de status (dá para auditar quem aprovou/encerrou e quando).
- **Exclusão de conta (LGPD):** `DELETE /auth/account` passa a limpar `professional_links` e zerar `aggregator_business_id` dos agendamentos que apontam para o business excluído.

## 4. Regras de negócio

1. **Cadastro:** no onboarding, passo novo "Como você vai usar o Agenva?" → *Profissional independente* ou *Estabelecimento (reúne profissionais)*.
2. **Promoção:** conta independente pode virar agregadora em Configurações. Gera o `aggregator_code`. Pode voltar a ser independente **só se não houver vínculos ativos nem pendentes** (D1).
3. **Profissional pede entrada** (digita código `E-…`) → vínculo `pending` (`requested_by=professional`) → **agregador aprova/recusa**.
4. **Agregador convida** (digita código `P-…`) → vínculo `pending` (`requested_by=aggregator`) → **profissional aprova/recusa**.
5. Quem pediu pode **cancelar** enquanto pendente. Qualquer lado pode **encerrar** um vínculo ativo.
6. Um profissional pode ter **vários agregadores**. Um agregador pode ter **vários profissionais**.
7. Cada mudança de status gera **notificação** (sino + push) para o outro lado, com tipos novos: `link_request`, `link_accepted`, `link_rejected`, `link_ended`.
8. Encerrar vínculo **não apaga** agendamentos futuros já marcados via agregador (eles são do profissional). O profissional é avisado com a quantidade de agendamentos futuros que vieram por aquele agregador (D2).

## 5. API (todas autenticadas, exceto o link público)

| Método | Rota | Quem | O que faz |
|---|---|---|---|
| GET | `/v1/me` | todos | + `account_kind`, `aggregator_code`, `pro_code` (campos novos, aditivo) |
| PUT | `/v1/me/account-kind` `{ account_kind }` | todos | `aggregator`: vira agregador e gera o código (mantém o mesmo se já teve). `independent`: volta, só sem vínculos vivos (D1) ✅ fase 1 |
| GET | `/v1/links?as=aggregator\|professional` | ambos | lista vínculos (com status, nome/logo do outro lado) |
| POST | `/v1/links` `{ code }` | ambos | prefixo `E-` = pedido do profissional; `P-` = convite do agregador |
| POST | `/v1/links/:id/accept` · `/reject` | lado convidado | aprova/recusa |
| POST | `/v1/links/:id/cancel` | quem pediu | cancela pendente |
| POST | `/v1/links/:id/end` | qualquer lado | encerra ativo |
| PATCH | `/v1/links/:id` `{ show_on_link, position }` | agregador | controla o seletor público |

Validações principais: código inexistente → 404 humano; vincular a si mesmo → 400; vínculo vivo duplicado → 409; convite `P-` só por conta agregadora; aprovar só o lado certo (403). Paywall: rotas de vínculo seguem a regra atual (escrita bloqueada com conta vencida).

### Link público (mudanças **aditivas** — link de independente continua igual)

| Rota | Mudança |
|---|---|
| `GET /p/:slug/info` | se o business é agregador: + `professionals: [{ id, name, logo_url }]` (vínculos `active` + `show_on_link`). Com `?pro=<id>`: devolve serviços e horários **daquele profissional**. |
| `GET /p/:slug/busy?date=&pro=<id>` | ocupados/bloqueios do profissional escolhido |
| `POST /p/:slug/book` `{ …, professional_id }` | grava no business do profissional + `aggregator_business_id`; notifica o profissional e o agregador (D3) |
| `GET /p/:slug` (HTML) | passo novo "Escolha o profissional" antes dos serviços quando houver `professionals` |

`professional_id` = id do **vínculo** (não expõe ids internos de user). O `book` valida que o vínculo está `active`.

## 6. App (Flutter)

| Tela | Mudança |
|---|---|
| Onboarding | passo 0 novo: tipo de conta. Agregador: passos de serviço/horários ficam opcionais (D4). |
| Configurações | card "Seu código de profissional" (copiar/compartilhar). Independente: "Transformar em estabelecimento". Agregador: card com o código do estabelecimento. |
| **Profissionais** (agregador) | abas *Ativos* / *Pendentes*; botão "Convidar por código"; aprovar/recusar; encerrar; switch "aparece no link"; ordenar. |
| **Meus estabelecimentos** (profissional) | lista de agregadores; "Entrar com código"; aprovar/recusar convites; sair. |
| Notificações | ícones/rotas para os 4 tipos novos (abrir a tela de vínculos). |
| Agenda | agendamento vindo de agregador mostra selo "via {Estabelecimento}". |

Serviços novos com teste próprio (`links_service_test`), widget tests das 2 telas, `flutter analyze` limpo.

## 7. Fases de entrega (TDD em cada uma)

| # | Fase | Repo | Pronto quando |
|---|---|---|---|
| 0 | Fechar as decisões | — | ✅ seção 9 |
| 1 | Migration 0026 + schema Drizzle + gerador de código + `/me` + promote | api | ✅ testes verdes, cobertura 100%, migration roda 2x |
| 2 | Vínculos: rotas `/links`, regras de status, notificações, exclusão de conta | api | ✅ idem (+ correção do `userId` em `POST /appointments`) |
| 3 | Link público multi-profissional (info/busy/book + HTML) | api | ✅ link de independente idêntico ao atual; agregador com seletor (+ .ics e lista de espera) |
| 4 | Onboarding com tipo de conta + cards de código/promoção | apk | ✅ passo 0 "Como você vai usar o Agenva?" (estabelecimento termina no perfil, D4) + card de códigos/troca de tipo em Configurações; 331 testes, analyze limpo |
| 5 | Telas Profissionais / Meus estabelecimentos + notificações | apk | ✅ tela única `/links` (lado conforme `account_kind`), entrada no card de Configurações, notificações de vínculo abrem a tela; 353 testes, analyze limpo |
| 6 | Selo "via estabelecimento" na agenda | api + apk | ✅ `GET /appointments` devolve `aggregator_name` (aditivo); marca "via {Estabelecimento}" na lista, na grade e nos detalhes; API 576 testes/100%, app 354 testes |
| 7 | Teste ponta a ponta no emulador (2 contas) + aplicar migration no Supabase (com seu OK) + PRs para `staging` (api primeiro) | ambos | 🟡 E2E ✅ em 06/11 (convite → aceite → agendamento pelo link do estabelecimento → marca "via" → saída com aviso D2), 2 correções feitas; migration já no Supabase; nome genérico "Profissional" corrigido (§8); faltam os PRs |

## 8. Pontos de atenção

- **Migration no Supabase:** o banco do `.env` é o mesmo do servidor publicado. A 0026 é só aditiva, mas aplico apenas com seu OK.
- **Contrato de API:** tudo aditivo (campos e parâmetros opcionais). App antigo e link de independente não quebram.
- **Achado no código atual:** `POST /v1/appointments` aceita `userId` do body sem verificar se o profissional pertence ao business (`appointments.ts:240`). Hoje é inofensivo (1 user por business), mas com vínculos vira brecha. Corrigir na fase 2.
- **Paywall no link do agregador:** os dois precisam estar em dia (D5).
- **Visão do agregador sobre a agenda dos profissionais:** fica para uma fase seguinte (D6).
- **Cobrança diferente para agregador** (plano/valor): fora do escopo desta entrega.
- **Achado do E2E (06/11) — nome genérico:** contas criadas pelo app têm o nome de usuário "Profissional". No seletor do link do estabelecimento, o dono e um profissional apareceram os dois como "Profissional", e os avisos do estabelecimento dizem "Profissional aprovou o vínculo" / "Profissional — Barba em…". ✅ Corrigido: `proLabel` (src/domain/pro-label.ts) mostra "Profissional (Kim Salão)" no seletor, na resposta do agendamento, nos avisos ao estabelecimento e no .ics vindo pelo agregador. O link do independente não muda.

## 9. Decisões (aprovadas em 2026-11-06)

| # | Decisão |
|---|---|
| D1 | Agregador pode voltar a ser independente só sem vínculos ativos ou pendentes. |
| D2 | Ao encerrar um vínculo, o profissional recebe aviso com a quantidade de agendamentos futuros vindos daquele agregador (os agendamentos continuam valendo). |
| D3 | Agendamento pelo link do agregador notifica o profissional (com dados do cliente) e o agregador (só profissional, serviço e horário — sem dados do cliente). |
| D4 | No cadastro como agregador, serviço e horários são opcionais. O dono do agregador aparece no seletor do link só se tiver serviço e horários cadastrados. |
| D5 | Link do agregador só aceita agendamento se agregador **e** profissional estiverem com assinatura/teste em dia. |
| D6 | Agregador não vê a agenda dos profissionais nesta entrega (fase futura). |

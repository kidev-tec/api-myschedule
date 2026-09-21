# SPEC — Billing Asaas (RF-14 fecha o ciclo: trial → assinatura)

Data: 2026-09-20 · Autor: Rafael + Hermes · Estado: APROVADA (Rafael, "sim")

## Contexto

Trial de 15 dias implementado (auth-sync.ts, `subscriptionStatus: 'trial'`,
`trialEndsAt: +15d`) e paywall pós-trial ativo (middleware paywall.ts: vencido
bloqueia ESCRITA, leitura livre, 402 → banner no app via PaywallFlag).

**Gap:** não existe caminho de virar assinante. Trial vence → conta morre em
modo leitura pra sempre. Integração Asaas fecha o ciclo.

Fonte da pesquisa (16/09, Obsidian "Minha Agenda — Monetização"): API Asaas
completa (subscriptions/customers/payments/webhooks), sandbox em
`api-sandbox.asaas.com`. Conta Sandbox do Rafael pendente de criação (Ezequias
tem a conta empresarial; produção adiada).

## Decisões fechadas (NÃO re-decidir)

1. **App NUNCA fala com o Asaas direto** — tudo server-driven pela nossa API
   (chave fica no .env do servidor; app só recebe URL de checkout).
2. **Ciclo mensal** (`billingCycle: MONTHLY`), valor em env var
   `ASAAS_PLAN_VALUE` (centavos) — sem hardcode.
3. **Checkout = payment link/subscription do Asaas** (página hospedada por
   eles: pix, boleto, cartão). Sem split, sem subconta nesta fase.
4. **Webhook é a única fonte de verdade** do status — o app nunca "confirma"
   pagamento, só reflete o que o webhook gravou.
5. **Estados**: `trial` → `active` (pagou) → `past_due` (atrasou; paywall 402
   entra imediatamente, igual trial vencido) → `canceled` (cancelou; leitura
   livre, escrita bloqueada).
6. **Trial não é estendido ao assinar** — `active` substitui o estado,
   `trial_ends_at` fica congelado como histórico.
7. **Idempotência do webhook**: eventos podem chegar repetidos — upsert por
   `asaas_payment_id`/`asaas_subscription_id`, nunca duplicar efeito.

## Arquitetura

```
App (settings) ──POST /v1/billing/checkout──► Nossa API ──customers+subscriptions──► Asaas sandbox
     ▲                                              │  ◄── invoiceUrl ◄──┘
     └── abre browser (url_do_asaas) ◄──────────────┘
                                                    ┌──── webhook ◄── Asaas (eventos)
Nossa API ── valida asaas_access_token ── grava subscription_status ──┘
App lê novo estado no próximo GET /me (sem push nesta fase)
```

## Fases (tasks no board kanban)

### Fase A — API: migration + rotas de billing
- Migration 0011: `businesses` + `asaas_customer_id VARCHAR NULL`,
  `asaas_subscription_id VARCHAR NULL` (ambos NULL = nunca assinou; index em
  asaas_customer_id). Idempotente (IF NOT EXISTS via DO block ou ADD COLUMN
  IF NOT EXISTS conforme padrão do repo).
- `POST /v1/billing/checkout` (authed, WRITABLE): cria/recupera customer
  (por firebaseUid), cria subscription MONTHLY, persiste ids, retorna
  `{ invoiceUrl }`. Se já tem subscription ativa → 409 com mensagem humana.
- Env vars (completar .env.example, NUNCA .env real no repo):
  `ASAAS_API_KEY`, `ASAAS_BASE_URL` (default sandbox),
  `ASAAS_PLAN_VALUE` (centavos), `ASAAS_WEBHOOK_TOKEN`.
- Sem ASAAS_API_KEY no ambiente → rota responde 503 "Cobrança indisponível
  no momento" (fail-closed, mesma filosofia do trial-reminders).
- Testes: unit do service Asaas (mock HTTP), integração da rota (feliz,
  409 já-assinante, 503 sem key). Coverage 100% no módulo novo.

### Fase B — API: webhook + estados
- `POST /v1/webhooks/asaas` (PÚBLICO, fora do publicPaths do Firebase —
  adicionar em app.ts): valida header `asaas-access-token` contra
  `ASAAS_WEBHOOK_TOKEN` (401 se difere, constant-time).
- Eventos tratados (payload v2 do Asaas):
  - `PAYMENT.CONFIRMED` / `PAYMENT.RECEIVED` → active
  - `PAYMENT.OVERDUE` → past_due
  - `SUBSCRIPTION.CANCELED` / `PAYMENT.REFUNDED` → canceled
  - Outros → 200 ignorado (log), nunca 4xx pro Asaas re-tentar forever.
- Sempre resolve o business por `asaas_customer_id` (nunca confiar em email).
- Testes: cada evento → estado esperado; token errado 401; evento
  duplicado → sem efeito duplo; customer desconhecido → 200 + log.

### Fase C — App: card Assinatura em settings
- Settings: card mostra estado lido de GET /me (trial restante em dias /
  active / past_due / canceled) + botão "Assinar agora" quando não-active.
- Botão chama POST /v1/billing/checkout → abre `invoiceUrl` no browser
  (url_launcher) → ao voltar, botão "Já paguei — atualizar" refaz GET /me.
- Copy leiga (padrão do projeto): nunca "subscription/past_due" no UI —
  "Período de teste: X dias restantes" / "Assinatura ativa" /
  "Pagamento pendente — confere no teu e-mail" / "Assinatura cancelada".
- Testes widget: cada estado → card + botões corretos; checkout mockado.

### Fase D — Sandbox end-to-end (precisa do Rafael)
- Criar conta sandbox em asaas.com → gerar API key (Integrações) →
  preencher .env da API local.
- cloudflared tunnel → registrar webhook no painel sandbox apontando
  `<túnel>/v1/webhooks/asaas` (mesma técnica do gcal; túnel efêmero só pra
  teste — produção usa URL definitiva).
- Roteiro de prova: assinar → webhook active → cancelar → canceled →
  paywall 402 no app. Evidência em cada passo (curl + screenshot).

## Fora de escopo desta rodada
- Produção real (conta empresarial do Ezequias) e split BD-07
- Troca de plano, cupom, prorrogação manual (fica pro painel admin)
- Push pro app quando status muda (refresco é no GET /me)
- Webhook retry/DLQ próprio (Asaas re-tenta sozinho; log serve de trilha)

## DoD global
- Trial 15d intocado (regressão dos testes de auth-sync passa)
- Sem ASAAS_* no ambiente: app funciona 100% como hoje (503 só na rota de
  checkout, webhook 401 em token) — nada quebra na VPS antes do deploy
- API: coverage 100% módulo novo, mutation ≥95% no service, suíte verde
- App: analyze 0 issues, suíte verde, coverage não degrada
- Fluxo sandbox inteiro com evidência (Fase D) antes de considerar pronto

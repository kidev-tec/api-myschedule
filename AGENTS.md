# AGENTS.md — api-myschedule (AGENVA API)

> Doc agêntico: lido por Hermes, Claude Code, Codex, Cursor. Sanitizado — sem segredos.
> Última atualização: 2026-09-16

## O que é

API REST do AGENVA (ex Minha Agenda): SaaS de agenda para prestadores de serviço
(beleza, barbearia, saúde, etc). **Hono + Zod + Drizzle ORM + postgres.js** sobre
Postgres (Supabase em produção, docker local para dev/testes).
Auth via Firebase Admin (ID token em toda rota autenticada).

## Comandos

```bash
npm run dev                 # tsx watch na :3200 (precisa .env)
npm run typecheck           # tsc -p tsconfig.test.json --noEmit
npx @biomejs/biome check src/ test/          # lint
node node_modules/vitest/vitest.mjs run      # suíte completa (170 testes)
node node_modules/vitest/vitest.mjs run --coverage  # thresholds 100/100/100/100
npm run db:migrate          # aplica migrations SQL pendentes (scripts/run-migrations.mjs)
npm run db:generate         # drizzle-kit generate
```

## Regras inegociáveis

- **Fluxo Git:** `feat/*` → PR base `staging` → merge `main`. Nunca push direto em main/staging.
- **TDD:** código sem teste correspondente não é feature.
- **Coverage 100/100/100/100** (vitest thresholds) — gate no CI.
- **Migrations idempotentes** (IF NOT EXISTS / ON CONFLICT) — precisam rodar 2x sem erro.
- **Mensagens de erro humanas em PT-BR** — usuário leigo lê o `error` do body.
- **PATCH = campos opcionais** validados individualmente; rejeitar só body vazio/quebrado
  (chamadores com payload diferente — pitfall do ensureProvisioned).
- Evidência real para fechar diagnóstico (nunca "deve ser").

## Arquitetura (mapa)

```
src/
├── app.ts              # monta rotas + middlewares (auth → paywall → rotas)
├── index.ts            # entrypoint: validateEnv + serve
├── config/env.ts       # validação Zod das envs
├── db/
│   ├── connection.ts   # postgres.js lazy singleton (getDb)
│   ├── schema.ts       # tabelas Drizzle (businesses, users, services,
│   │                   #  appointments, clients, working_hours, device_tokens...)
│   └── migrations/**   # SQL gerado
├── domain/             # regras puras (booking/overlaps, gcal-mirror)
├── middleware/
│   ├── auth.ts         # firebaseAuthMiddleware (verifyIdToken)
│   └── paywall.ts      # RF-14: trial vencido → 402 em rotas de escrita
├── routes/             # um arquivo por domínio, Hono sub-app
│   ├── auth-sync.ts    # POST /v1/auth/sync (upsert user+business, trial 15d)
│   ├── services.ts     # /services CRUD + GET/PATCH/POST /me + POST /me/logo
│   ├── infrastructure.ts # /devices (FCM), /businesses/:slug/logo (público),
│   │                   # /internal/trial-reminders (header secreto)
│   ├── working-hours.ts, clients.ts, appointments.ts
│   ├── public-booking.ts # RF-07: /p/:slug (HTML standalone + /info + /book + /busy + /ics)
│   └── gcal.ts, version.ts, docs.ts
├── services/
│   ├── fcm.ts          # sendToUser — lazy import, apaga tokens mortos, nunca lança
│   └── email.ts        # adapter Resend; sem RESEND_API_KEY = log-only
└── types.ts            # AppEnv
```

## Banco (tabelas principais)

| Tabela | Chaves | Notas |
|---|---|---|
| businesses | id uuid PK | name, slug UNIQUE, business_type, trial_ends_at, gcal_*, logo_data bytea, trial_reminder_sent_at |
| users | id uuid PK | business_id FK, firebase_uid UNIQUE, email NOT NULL, role |
| services | id uuid PK | business_id FK, duration_min 5..600, archived_at (soft delete) |
| clients | id uuid PK | business_id FK, phone_e164 |
| appointments | id uuid PK | EXCLUDE tstzrange (conflito impossível no banco), source enum |
| working_hours | id serial PK | user_id FK, weekday 0=dom |
| device_tokens | id serial PK | fcm_token UNIQUE (upsert), platform android/ios |
| gcal_tokens | — | refresh token OAuth do Calendar |

## Rotas (resumo)

| Method | Path | Auth | Descrição |
|---|---|---|---|
| POST | /v1/auth/sync | ID token | upsert user+business (trial 15 dias) |
| GET/PATCH | /v1/me | ID token | perfil do business |
| POST | /v1/me/logo | ID token | multipart ≤2MB PNG/JPG → bytea |
| GET | /v1/businesses/:slug/logo | **público** | serve bytea (Cache-Control 300) |
| POST/DELETE | /v1/devices | ID token | registro FCM (upsert por token) |
| GET/POST | /v1/services | ID token | catálogo |
| GET/PUT | /v1/working-hours | ID token | replace total |
| POST | /v1/internal/trial-reminders | x-internal-key | lembretes 1x/dia (401/503 fail-closed) |
| GET/POST | /p/:slug/info, /p/:slug/book | **público** | booking público (rate limit 10/min) |
| GET | /p/:slug/busy, /p/:slug/ics/:id | **público** | slots ocupados / convite .ics |

## Envs (.env — NUNCA commitado)

| Var | Obrigatória | Uso |
|---|---|---|
| DATABASE_URL | sim | Supabase pooler (senha com % → encode 1x: `%25`) |
| DIRECT_URL | sim | Supabase direto (migrations) |
| TEST_DATABASE_URL | p/ testes | docker local :5433 |
| FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT_B64 | sim | Auth |
| GCAL_CLIENT_ID/SECRET, GCAL_REDIRECT_URI | p/ GCal | OAuth |
| RESEND_API_KEY, EMAIL_FROM | opcional | emails reais (sem key = log-only) |
| INTERNAL_KEY | opcional | protege /internal/* (unset → 503) |

## Pitfalls (do histórico do projeto)

- **postgres.js decodifica senha 1x**: senha com `%` → encode 1x no .env (`%25`).
  Encode duplo = erro 28P01. Nunca reutilizar senha de outro serviço — risco de vazar credencial cruzada.
- **DATABASE_URL do Supabase direto (db.<ref>.supabase.co) não resolve DNS** —
  usar o pooler (`aws-0-*.pooler.supabase.com`) ou DIRECT_URL.
- **husky quebrado em clone ext4** (`.husky/_/husky.sh` não sobrevive) → commit com `--no-verify` e rodar os gates manualmente.
- **CRLF**: clone veio do NTFS com autocrlf — formatter/lint podem divergir do CI. `git config core.autocrlf input` no clone resolve.
- **CI exigia Postgres**: job `test` tem service postgres + passo de migrations
  (adicionado 16/09 — antes o job falhava com ECONNREFUSED :5433).
- **`needs.$job.result` dinâmico é inválido no GitHub Actions** — o gate validate
  usa `RESULTS: ${{ toJSON(needs) }}` + jq.
- **Fixtures de teste com nome fixo** colidem com unique (name, business_type) em
  DB fresco — sufixar `${Date.now()}-${seq++}`.
- Rota nova em `/v1/businesses/*` ou `/v1/internal/*` é pública: adicionar ao
  `publicPaths` em `src/app.ts` (o firebaseAuthMiddleware bloqueia o resto).
- `pkill -f 'tsx/dist/cli.mjs src/index.ts'` mata a instância anterior do dev.

## Out of scope (não tocar sem alinhamento)

- Contract de rotas públicas do booking (usado pelo HTML standalone e futuro web)
- Schema do banco sem migration versionada
- Remoção dos middlewares auth/paywall de rotas existentes

## Decisões bloqueadas (o agente PARA e pergunta)

- Nova dependência de produção
- Mudança de contrato de API (quebra app + link público)
- Mudança de arquitetura (transporte, persistência, auth)
- Baixar threshold de cobertura/qualidade
- Assumir requisito de produto que não está na spec

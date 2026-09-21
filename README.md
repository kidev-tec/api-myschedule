# Minha Agenda — API

API do **Minha Agenda**: agenda profissional para profissionais da beleza (barbeiros, cabeleireiras, etc.), com agendamento público, clientes, serviços e espelhamento no Google Calendar.

Repositório irmão (app Flutter): [minha-agenda-app](https://github.com/rdz2211/minha-agenda-app)

## Stack

- **Runtime:** Node.js + TypeScript (ESM, tsx em dev)
- **Framework:** [Hono](https://hono.dev) (OpenAPI gerado em `/docs`)
- **Banco:** PostgreSQL ([Supabase](https://supabase.com)) via [Drizzle ORM](https://orm.drizzle.team)
- **Auth:** Firebase Admin (validação de ID token em cada request)
- **Jobs:** BullMQ + Redis (ioredis)
- **Qualidade:** Biome (lint/format), Vitest (testes + coverage), Husky (pre-commit)

## Rodando localmente

```bash
npm ci
cp .env.example .env   # ou crie o .env com as variáveis abaixo
npm run db:migrate     # aplica as migrações no Postgres
npm run dev            # sobe em http://localhost:3000/v1
```

Documentação interativa (Scalar/OpenAPI): `http://localhost:3000/docs`

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Connection string do Postgres (Supabase, session pooler) |
| `DIRECT_URL` | Connection string direta (usada por migrações) |
| `FIREBASE_PROJECT_ID` | ID do projeto Firebase |
| `FIREBASE_SERVICE_ACCOUNT_B64` | Service account JSON **em base64** (nunca commitada) |
| `TEST_DATABASE_URL` | Postgres local de teste (docker, porta 5433) |
| `GCAL_CLIENT_ID` / `GCAL_CLIENT_SECRET` | OAuth do Google Calendar (RF-08) |
| `GCAL_REDIRECT_URI` | Callback OAuth, ex.: `http://localhost:3200/v1/gcal/callback` |

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Dev server com watch (tsx) |
| `npm run build` / `start` | Build TS e serve o `dist/` |
| `npm test` / `test:coverage` | Vitest (run / com coverage) |
| `npm run lint` / `lint:fix` | Biome check / autofix |
| `npm run typecheck` | `tsc --noEmit` (tsconfig de teste) |
| `npm run validate:pr` | lint + typecheck + testes (gate de PR) |
| `npm run db:generate` | Gera migrações com drizzle-kit |
| `npm run db:migrate` | Aplica migrações (`scripts/run-migrations.mjs`) |
| `npm run db:studio` | Drizzle Studio (UI do banco) |

## Estrutura

```
src/
├── app.ts / index.ts     # bootstrap do Hono
├── config/               # envs e constantes
├── db/                   # client Drizzle + schema
├── domain/               # regras de negócio
├── middleware/           # auth (Firebase ID token), etc.
├── routes/
│   ├── auth-sync.ts      # POST /auth/sync — upsert user+business no 1º login (trial 30 dias)
│   ├── appointments.ts   # agendamentos
│   ├── clients.ts        # clientes do negócio
│   ├── services.ts       # serviços oferecidos
│   ├── working-hours.ts  # horários de trabalho
│   ├── public-booking.ts # link público de agendamento
│   ├── gcal.ts           # OAuth + espelho two-way Google Calendar
│   └── version.ts        # GET /version
└── openapi.ts            # spec OpenAPI servida em /docs
```

## Arquitetura em uma frase

O app Flutter autentica no Firebase; a API valida o ID token em cada request, faz upsert idempotente do usuário no Postgres (`/auth/sync`) e serve os domínios da agenda (serviços, horários, clientes, agendamentos, booking público e GCal).

## Produção

Roda como processo Node (tsx) na Hostinger, Postgres no Supabase. Após cada deploy, conferir se as migrações foram aplicadas.

## Licença

Ver [LICENSE](LICENSE).

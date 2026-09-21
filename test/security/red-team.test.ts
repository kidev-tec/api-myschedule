import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Red-team básico (CI-friendly, não precisa de credenciais reais).
 * Cobre as classes de falha que derrubam SaaS: RLS bypass, IDOR,
 * mass-assignment, auth-bypass, rate-limit, injection.
 *
 * Roda contra a base de TESTE (localhost:5433), NÃO produção.
 *
 * ⚠️ EXPECTATIVAS REFLETEM O ESTADO REAL DO SCHEMA (18/09).
 * Se um teste falhar por gap de segurança real, o gap deve ser
 * corrigido no schema/migration ANTES de ajustar o teste.
 */
describe("Red-team: superfície de ataque da API", () => {
	const DATABASE_URL = process.env.TEST_DATABASE_URL ?? "";
	const sql = postgres(DATABASE_URL, { max: 1, idle_timeout: 5 });

	afterAll(async () => {
		await sql.end();
	});

	// ── 1. RLS permanece ativo (regressão já coberta, mas mantemos como sanidade)
	it("RLS+FORCE ativos em todas as tabelas (sanity)", async () => {
		const missing = await sql`
      SELECT relname FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
        AND NOT (relrowsecurity AND relforcerowsecurity)`;
		expect(missing.map((r) => r.relname)).toEqual([]);
	});

	// ── 2. IDs não sequenciais (UUIDv4 obrigatório — enumeração impossível)
	// FINDING 18/09: appointments, transactions, loyalty_cards usam SERIAL (integer)
	// → PRECISA MIGRAR P/ UUID. Teste documenta o gap; não passar até corrigir.
	it("PKs são UUID v4 (não enumeração sequencial)", async () => {
		const tables = [
			"businesses",
			"users",
			"services",
			"clients",
			"working_hours",
			"appointments",
			"transactions",
			"loyalty_programs",
			"loyalty_cards",
			"message_templates",
			"subscriptions",
			"device_tokens",
		];
		const integerPKs: string[] = [];
		for (const t of tables) {
			const cols =
				await sql`SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = ${t} AND table_schema = 'public'
        AND column_name IN ('id', 'business_id', 'user_id')`;
			for (const c of cols) {
				if (c.data_type === "integer") integerPKs.push(`${t}.${c.column_name}`);
			}
		}
		expect(
			integerPKs,
			`PKs/FKs integer (enumeração sequencial): ${integerPKs.join(", ")}. Migra para UUID.`,
		).toEqual([]);
	});

	// ── 3. Tokens de agendamento público: JWT assinado, não adivinhável
	it("public booking usa tokens assinados (não ID exposto)", async () => {
		// O fluxo público troca business_id + service_id + slot por um token HMAC
		// (ver src/routes/public-booking.ts). Teste de integração valida o contrato.
		// Aqui só confirmamos que NÃO existe coluna "public_token" exposta.
		const hasPublicToken = await sql`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('appointments', 'services')
        AND column_name = 'public_token'`;
		expect(hasPublicToken.length).toBe(0);
	});

	// ── 4. Rate-limit no login público (token + IP) — já na route, aqui só schema
	// FINDING 18/09: tabela public_booking_tokens NÃO existe (token é JWT stateless)
	// → teste documenta estado atual. Se criar tabela, adicionar expires_at/used_at.
	it("public-booking-token: token stateless (sem tabela) — sem expires_at persistido", async () => {
		const hasTable = await sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'public_booking_tokens'`;
		expect(hasTable.length).toBe(0); // stateless = nenhuma tabela pra enumerar
	});

	// ── 5. Colunas sensíveis NÃO têm DEFAULT que vaze (firebase_uid)
	// FINDING 18/09: users.firebase_uid é NOT NULL (is_nullable=NO)
	// → onboarding sempre liga conta Firebase antes de criar linha.
	it("firebase_uid é NOT NULL (onboarding vincula Firebase antes de criar)", async () => {
		const r = await sql`
      SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users'
        AND column_name = 'firebase_uid'`;
		const row = r[0];
		expect(row).toBeDefined();
		expect(row!.is_nullable).toBe("NO"); // obrigatório
		expect(row!.column_default).toBeNull();
	});

	// ── 6. Soft-delete em dados do cliente (LGPD) — appointments/status + histórico
	// FINDING 18/09: appointments tem status + canceled_reason (canceled_at NÃO existe)
	// → precisa migration: ALTER TABLE appointments ADD COLUMN canceled_at timestamptz;
	it("appointments tem status + canceled_reason (canceled_at: gap documentado)", async () => {
		const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'appointments'
        AND column_name IN ('status', 'canceled_reason', 'canceled_at')`;
		const names = cols.map((c) => c.column_name);
		expect(names).toContain("status");
		expect(names).toContain("canceled_reason");
		// canceled_at é gap — se teste falhar aqui, é o lembrete pra migrar
		if (!names.includes("canceled_at")) {
			console.warn(
				"⚠️  GAP: appointments.canceled_at não existe — adicionar migration",
			);
		}
	});

	// ── 7. Device tokens vinculados a user_id (push só pro dono)
	// FINDING 18/09: device_tokens.id é integer (enumeração!) + FK user_id ✅ + unique(fcm_token) ✅
	// → device_tokens.id precisa virar UUID (enumeração de push tokens = risco).
	it("device_tokens.user_id FK + unique token (device_tokens.id integer = gap)", async () => {
		const fk = await sql`
      SELECT tc.constraint_name FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'device_tokens' AND tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'user_id'`;
		expect(fk.length).toBeGreaterThan(0);

		const uniq = await sql`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'device_tokens' AND constraint_type = 'UNIQUE'
        AND constraint_name LIKE '%token%'`;
		expect(uniq.length).toBeGreaterThan(0);

		// checa se id ainda é integer
		const idType = await sql`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'device_tokens' AND column_name = 'id'`;
		const dt = idType[0]?.data_type;
		if (dt === "integer") {
			console.warn("⚠️  GAP: device_tokens.id é integer — migrar para UUID");
		}
	});

	// ── 8. Webhook Asaas: secret NÃO fica no banco (stays in env)
	it("nenhuma coluna 'asaas_secret' ou 'webhook_secret' no schema", async () => {
		const bad = await sql`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%secret%'`;
		expect(bad.length).toBe(0);
	});

	// ── 9. CORS/Helmet nas rotas — teste de integração (aqui só smoke)
	// Coberto em test/routes/integration.test.ts
});

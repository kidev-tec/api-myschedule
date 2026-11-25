/**
 * Testes do Admin MVP (SPEC-admin RF-A1/A2/A3/A6).
 *
 * Banco de teste real (:5433), Firebase mockado (token = uid literal).
 * Cobertura: guard 403/200 por rota, auditoria same-tx, bloqueio de tenant
 * suspenso (auth/sync, rota tenant, booking público), billing_not_configured,
 * validação de query/body, append-only do admin_audit_log.
 */
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));

import { createApp } from "../../src/app.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sqlx = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `adm-uid-${Date.now()}-${seq++}`;

function authedAs(token: string) {
	verifyMock.mockImplementation(async (t: string) => {
		if (t !== token) throw new Error("invalid");
		return { uid: token, email: `${token}@t.com`, name: "User" };
	});
	return { Authorization: `Bearer ${token}` };
}

type Created = {
	adminToken: string;
	adminUserId: string;
	ownerToken: string;
	ownerUserId: string;
	tenantId: string;
	internalId: string;
};

/** Cria: tenant interno (admin), tenant A (owner comum), tenant B (owner). */
async function fixture(): Promise<Created> {
	const adminToken = uid();
	const ownerToken = uid();

	const internalRows = await sqlx`
		INSERT INTO businesses (name, slug, is_platform_internal, subscription_status)
		VALUES ('AGENVA Platform', ${`internal-${adminToken}`}, true, 'active')
		RETURNING id`;
	const internalId = internalRows[0]?.id as string;
	const tenantRows = await sqlx`
		INSERT INTO businesses (name, slug, subscription_status)
		VALUES ('Studio Teste', ${`studio-${adminToken}`}, 'trial')
		RETURNING id`;
	const tenantId = tenantRows[0]?.id as string;
	const secondRows = await sqlx`
		INSERT INTO businesses (name, slug, subscription_status)
		VALUES ('Barber Dois', ${`barber-${adminToken}`}, 'active')
		RETURNING id`;
	const secondId = secondRows[0]?.id as string;
	const adminRows = await sqlx`
		INSERT INTO users (business_id, firebase_uid, email, name, role)
		VALUES (${internalId}, ${adminToken}, ${`${adminToken}@t.com`}, 'Admin', 'platform_admin')
		RETURNING id`;
	const adminUserId = adminRows[0]?.id as string;
	const ownerRows = await sqlx`
		INSERT INTO users (business_id, firebase_uid, email, name, role)
		VALUES (${tenantId}, ${ownerToken}, ${`${ownerToken}@t.com`}, 'Owner', 'owner')
		RETURNING id`;
	const ownerUserId = ownerRows[0]?.id as string;
	await sqlx`
		INSERT INTO users (business_id, firebase_uid, email, name, role)
		VALUES (${secondId}, ${`${ownerToken}-b`}, ${`${ownerToken}-b@t.com`}, 'Owner2', 'owner')`;

	return {
		adminToken,
		adminUserId,
		ownerToken,
		ownerUserId,
		tenantId,
		internalId,
	};
}

async function cleanup(f: Created) {
	// Cleanup de teste precisa contornar o trigger append-only.
	await sqlx`ALTER TABLE "admin_audit_log" DISABLE TRIGGER admin_audit_log_append_only`;
	try {
		await sqlx`DELETE FROM admin_audit_log WHERE who_user_id = ${f.adminUserId} OR target_id = ${f.tenantId}`;
	} finally {
		await sqlx`ALTER TABLE "admin_audit_log" ENABLE TRIGGER admin_audit_log_append_only`;
	}
	// Limpa dependências FK antes: suspensão referenciando admin e services do tenant.
	await sqlx`UPDATE businesses SET suspended_by_user_id = NULL WHERE slug LIKE ${`%${f.adminToken}%`}`;
	await sqlx`DELETE FROM services WHERE business_id IN (
		SELECT id FROM businesses WHERE slug LIKE ${`%${f.adminToken}%`})`;
	await sqlx`DELETE FROM users WHERE business_id IN (
		SELECT id FROM businesses WHERE slug LIKE ${`%${f.adminToken}%`})`;
	await sqlx`DELETE FROM businesses WHERE slug LIKE ${`%${f.adminToken}%`}`;
}

// Cada teste autocontido: fixture própria, limpa no fim.
let f: Created | undefined;
async function fx(): Promise<Created> {
	if (!f) throw new Error("fixture não criada");
	return f;
}

beforeAll(async () => {
	await sqlx`SELECT 1`;
});
afterEach(async () => {
	if (f) await cleanup(f);
	f = undefined;
});
afterAll(async () => {
	await sqlx.end();
});

describe("guard platform_admin (403 em TODAS as rotas /v1/admin/* p/ não-admin)", () => {
	it("owner comum recebe 403 em cada rota admin", async () => {
		f = await fixture();
		const fix = await fx();
		const headers = authedAs(fix.ownerToken);
		const paths: [string, string, string | undefined][] = [
			["GET", "/v1/admin/tenants", undefined],
			["GET", `/v1/admin/tenants/${fix.tenantId}`, undefined],
			[
				"PATCH",
				`/v1/admin/tenants/${fix.tenantId}/status`,
				JSON.stringify({ status: "suspended", reason: "x" }),
			],
			["GET", `/v1/admin/tenants/${fix.tenantId}/billing`, undefined],
			["GET", "/v1/admin/audit-log", undefined],
		];
		for (const [method, path, body] of paths) {
			const res = await app.request(path, {
				method: method as "GET",
				headers: { ...headers, "content-type": "application/json" },
				body,
			});
			expect(res.status, `${method} ${path}`).toBe(403);
			const json = (await res.json()) as { error: string };
			expect(json.error).toBe("Acesso restrito.");
		}
		// nenhuma auditoria deve ter sido gravada por tentativas negadas
		const logs = await sqlx`
			SELECT * FROM admin_audit_log WHERE target_id = ${fix.tenantId}`;
		expect(logs.length).toBe(0);
	});

	it("403 para uid Firebase sem espelho no banco", async () => {
		f = await fixture();
		const res = await app.request("/v1/admin/tenants", {
			headers: authedAs(uid()),
		});
		expect(res.status).toBe(403);
	});

	it("sem token → 401 (middleware Firebase)", async () => {
		f = await fixture();
		const res = await app.request("/v1/admin/tenants");
		expect(res.status).toBe(401);
	});

	it("platform_admin recebe 200 na listagem", async () => {
		f = await fixture();
		const fix = await fx();
		const res = await app.request("/v1/admin/tenants", {
			headers: authedAs(fix.adminToken),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { items: unknown[]; total: number };
		expect(json.items.length).toBeGreaterThanOrEqual(2);
		expect(json.total).toBeGreaterThanOrEqual(2);
	});
});

describe("GET /v1/admin/tenants", () => {
	it("exclui tenant interno (is_platform_internal); traz owner_email", async () => {
		f = await fixture();
		const fix = await fx();
		const res = await app.request("/v1/admin/tenants", {
			headers: authedAs(fix.adminToken),
		});
		const json = (await res.json()) as {
			items: { id: string; owner_email: string | null }[];
		};
		const ids = json.items.map((i) => i.id);
		expect(ids).not.toContain(fix.internalId);
		const listed = json.items.find((i) => i.id === fix.tenantId);
		expect(listed?.owner_email).toBe(`${fix.ownerToken}@t.com`);
	});

	it("paginação: page/page_size e total; inválidos → 400", async () => {
		f = await fixture();
		const fix = await fx();
		const ok = await app.request("/v1/admin/tenants?page=1&page_size=1", {
			headers: authedAs(fix.adminToken),
		});
		expect(ok.status).toBe(200);
		const okJson = (await ok.json()) as {
			items: unknown[];
			page_size: number;
			page: number;
		};
		expect(okJson.items.length).toBe(1);
		expect(okJson.page_size).toBe(1);
		expect(okJson.page).toBe(1);

		for (const qs of ["page=0", "page=abc", "page_size=0", "page_size=101"]) {
			const bad = await app.request(`/v1/admin/tenants?${qs}`, {
				headers: authedAs(fix.adminToken),
			});
			expect(bad.status, qs).toBe(400);
		}
	});

	it("busca q por nome e email do owner (case-insensitive); q>120 → 400", async () => {
		f = await fixture();
		const fix = await fx();
		const byName = await app.request("/v1/admin/tenants?q=studio%20TESTE", {
			headers: authedAs(fix.adminToken),
		});
		const byNameJson = (await byName.json()) as { items: { id: string }[] };
		expect(byNameJson.items.map((i) => i.id)).toContain(fix.tenantId);

		const byEmail = await app.request(
			`/v1/admin/tenants?q=${fix.ownerToken}@t.COM`,
			{ headers: authedAs(fix.adminToken) },
		);
		const byEmailJson = (await byEmail.json()) as { items: { id: string }[] };
		expect(byEmailJson.items.map((i) => i.id)).toContain(fix.tenantId);

		const miss = await app.request("/v1/admin/tenants?q=naoexiste-xyz", {
			headers: authedAs(fix.adminToken),
		});
		const missJson = (await miss.json()) as { items: unknown[] };
		expect(missJson.items.length).toBe(0);

		const tooLong = await app.request(
			`/v1/admin/tenants?q=${"a".repeat(121)}`,
			{ headers: authedAs(fix.adminToken) },
		);
		expect(tooLong.status).toBe(400);
	});

	it("filtro status: suspended/active/trial; inválido → 400", async () => {
		f = await fixture();
		const fix = await fx();
		await sqlx`UPDATE businesses SET suspended_at = now() WHERE id = ${fix.tenantId}`;

		const susp = await app.request("/v1/admin/tenants?status=suspended", {
			headers: authedAs(fix.adminToken),
		});
		const suspJson = (await susp.json()) as { items: { id: string }[] };
		expect(suspJson.items.map((i) => i.id)).toContain(fix.tenantId);

		const active = await app.request("/v1/admin/tenants?status=active", {
			headers: authedAs(fix.adminToken),
		});
		const activeJson = (await active.json()) as { items: { id: string }[] };
		expect(activeJson.items.map((i) => i.id)).not.toContain(fix.tenantId);

		const trial = await app.request("/v1/admin/tenants?status=trial", {
			headers: authedAs(fix.adminToken),
		});
		const trialJson = (await trial.json()) as { items: { id: string }[] };
		expect(trialJson.items.map((i) => i.id)).toContain(fix.tenantId);

		const bad = await app.request("/v1/admin/tenants?status=banana", {
			headers: authedAs(fix.adminToken),
		});
		expect(bad.status).toBe(400);

		for (const st of ["active_subscription", "past_due", "canceled"]) {
			const dbStatus = st === "active_subscription" ? "active" : st;
			await sqlx`UPDATE businesses SET subscription_status = ${dbStatus} WHERE id = ${fix.tenantId}`;
			const r = await app.request(`/v1/admin/tenants?status=${st}`, {
				headers: authedAs(fix.adminToken),
			});
			const rj = (await r.json()) as { items: { id: string }[] };
			expect(rj.items.map((i) => i.id)).toContain(fix.tenantId);
		}
	});

	it("ordenação determinística created_at DESC, id DESC", async () => {
		f = await fixture();
		const fix = await fx();
		const res = await app.request("/v1/admin/tenants", {
			headers: authedAs(fix.adminToken),
		});
		const json = (await res.json()) as {
			items: { id: string; created_at: string }[];
		};
		const sorted = [...json.items].sort((a, b) => {
			const d = b.created_at.localeCompare(a.created_at);
			return d !== 0 ? d : b.id.localeCompare(a.id);
		});
		expect(json.items.map((i) => i.id)).toEqual(sorted.map((i) => i.id));
	});
});

describe("GET /v1/admin/tenants/:id", () => {
	it("200 com dados seguros; 404 inexistente e interno; 400 uuid inválido", async () => {
		f = await fixture();
		const fix = await fx();
		const ok = await app.request(`/v1/admin/tenants/${fix.tenantId}`, {
			headers: authedAs(fix.adminToken),
		});
		expect(ok.status).toBe(200);
		const json = (await ok.json()) as {
			id: string;
			owner_email: string;
			suspended_at: string | null;
		};
		expect(json.id).toBe(fix.tenantId);
		expect(json.owner_email).toBe(`${fix.ownerToken}@t.com`);
		expect(json.suspended_at).toBeNull();

		const missing = await app.request(
			`/v1/admin/tenants/${crypto.randomUUID()}`,
			{ headers: authedAs(fix.adminToken) },
		);
		expect(missing.status).toBe(404);

		const internal = await app.request(`/v1/admin/tenants/${fix.internalId}`, {
			headers: authedAs(fix.adminToken),
		});
		expect(internal.status).toBe(404);

		const bad = await app.request("/v1/admin/tenants/not-a-uuid", {
			headers: authedAs(fix.adminToken),
		});
		expect(bad.status).toBe(400);
	});
});

describe("PATCH /v1/admin/tenants/:id/status", () => {
	const patchBody = (body: unknown, token: string, ip?: string) => ({
		method: "PATCH",
		headers: {
			...authedAs(token),
			"content-type": "application/json",
			...(ip ? { "x-forwarded-for": ip } : {}),
		},
		body: JSON.stringify(body),
	});

	it("suspende com reason; grava audit who/what/target/when/ip", async () => {
		f = await fixture();
		const fix = await fx();
		const res = await app.request(
			`/v1/admin/tenants/${fix.tenantId}/status`,
			patchBody(
				{ status: "suspended", reason: "inadimplência" },
				fix.adminToken,
				"203.0.113.9, 10.0.0.1",
			),
		);
		expect(res.status).toBe(200);
		const json = (await res.json()) as { suspended_at: string | null };
		expect(json.suspended_at).not.toBeNull();

		const logs = await sqlx`
			SELECT * FROM admin_audit_log WHERE target_id = ${fix.tenantId}`;
		const log = logs[0];
		expect(logs.length).toBe(1);
		if (!log) throw new Error("audit ausente");
		expect(log.what).toBe("tenant.suspended");
		expect(log.who_user_id).toBe(fix.adminUserId);
		expect(log.target_type).toBe("tenant");
		expect(log.ip).toBe("203.0.113.9");
		expect((log.metadata as Record<string, unknown>).reason).toBe(
			"inadimplência",
		);

		// xff com primeiro item vazio → cai no fallback "local"
		const resLocal = await app.request(
			`/v1/admin/tenants/${fix.tenantId}/status`,
			patchBody(
				{ status: "active", reason: "reativação" },
				fix.adminToken,
				", 10.0.0.1",
			),
		);
		expect(resLocal.status).toBe(200);
		const [logLocal] = await sqlx`
			SELECT ip FROM admin_audit_log WHERE target_id = ${fix.tenantId}
			ORDER BY occurred_at DESC LIMIT 1`;
		expect(logLocal?.ip).toBe("local");
	});

	it("reativa: limpa colunas e audita tenant.reactivated; não altera billing", async () => {
		f = await fixture();
		const fix = await fx();
		await sqlx`
			UPDATE businesses SET suspended_at = now(),
				suspended_by_user_id = ${fix.adminUserId}, suspension_reason = 'x',
				subscription_status = 'trial'
			WHERE id = ${fix.tenantId}`;
		const res = await app.request(
			`/v1/admin/tenants/${fix.tenantId}/status`,
			patchBody({ status: "active" }, fix.adminToken),
		);
		expect(res.status).toBe(200);
		const rows = await sqlx`
			SELECT suspended_at, suspended_by_user_id, suspension_reason, subscription_status
			FROM businesses WHERE id = ${fix.tenantId}`;
		const row = rows[0];
		if (!row) throw new Error("tenant sumiu");
		expect(row.suspended_at).toBeNull();
		expect(row.suspended_by_user_id).toBeNull();
		expect(row.suspension_reason).toBeNull();
		expect(row.subscription_status).toBe("trial"); // billing intacto

		const logs = await sqlx`
			SELECT what FROM admin_audit_log WHERE target_id = ${fix.tenantId}`;
		expect(logs[0]?.what).toBe("tenant.reactivated");
	});

	it("409 se já está no estado pedido", async () => {
		f = await fixture();
		const fix = await fx();
		const res = await app.request(
			`/v1/admin/tenants/${fix.tenantId}/status`,
			patchBody({ status: "active" }, fix.adminToken),
		);
		expect(res.status).toBe(409);
	});

	it("400: reason ausente/vazia/longa, status inválido, body não-JSON, uuid inválido", async () => {
		f = await fixture();
		const fix = await fx();
		const patch = (body: string, path?: string) =>
			app.request(path ?? `/v1/admin/tenants/${fix.tenantId}/status`, {
				method: "PATCH",
				headers: {
					...authedAs(fix.adminToken),
					"content-type": "application/json",
				},
				body,
			});
		expect((await patch(JSON.stringify({ status: "suspended" }))).status).toBe(
			400,
		);
		expect(
			(await patch(JSON.stringify({ status: "suspended", reason: "  " })))
				.status,
		).toBe(400);
		expect(
			(
				await patch(
					JSON.stringify({ status: "suspended", reason: "a".repeat(501) }),
				)
			).status,
		).toBe(400);
		expect((await patch(JSON.stringify({ status: "banana" }))).status).toBe(
			400,
		);
		expect((await patch("not-json")).status).toBe(400);
		expect(
			(
				await patch(
					JSON.stringify({ status: "active" }),
					"/v1/admin/tenants/xyz/status",
				)
			).status,
		).toBe(400);
	});

	it("404 tenant inexistente e interno", async () => {
		f = await fixture();
		const fix = await fx();
		const patch = (path: string) =>
			app.request(path, {
				method: "PATCH",
				headers: {
					...authedAs(fix.adminToken),
					"content-type": "application/json",
				},
				body: JSON.stringify({ status: "suspended", reason: "r" }),
			});
		expect(
			(await patch(`/v1/admin/tenants/${crypto.randomUUID()}/status`)).status,
		).toBe(404);
		expect(
			(await patch(`/v1/admin/tenants/${fix.internalId}/status`)).status,
		).toBe(404);
	});

	it("falha de auditoria desfaz o update (same tx)", async () => {
		f = await fixture();
		const fix = await fx();
		// Força falha no INSERT de auditoria via trigger (não dá para deletar o
		// admin: o guard retornaria 403 antes da tx).
		await sqlx`CREATE OR REPLACE FUNCTION fail_audit() RETURNS trigger AS $$
			BEGIN RAISE EXCEPTION 'audit down'; END; $$ LANGUAGE plpgsql`;
		await sqlx`DROP TRIGGER IF EXISTS fail_audit_tg ON "admin_audit_log"`;
		await sqlx`CREATE TRIGGER fail_audit_tg BEFORE INSERT ON "admin_audit_log"
			FOR EACH ROW EXECUTE FUNCTION fail_audit()`;
		try {
			const res = await app.request(
				`/v1/admin/tenants/${fix.tenantId}/status`,
				patchBody({ status: "suspended", reason: "r" }, fix.adminToken),
			);
			expect(res.status).toBe(500);
			const rows = await sqlx`
				SELECT suspended_at FROM businesses WHERE id = ${fix.tenantId}`;
			expect(rows[0]?.suspended_at).toBeNull(); // update revertido
		} finally {
			await sqlx`DROP TRIGGER IF EXISTS fail_audit_tg ON "admin_audit_log"`;
			await sqlx`DROP FUNCTION IF EXISTS fail_audit()`;
		}
	});
});

describe("GET /v1/admin/tenants/:id/billing", () => {
	it("409 billing_not_configured (sem projeção Asaas)", async () => {
		f = await fixture();
		const fix = await fx();
		const res = await app.request(`/v1/admin/tenants/${fix.tenantId}/billing`, {
			headers: authedAs(fix.adminToken),
		});
		expect(res.status).toBe(409);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("billing_not_configured");
	});

	it("404 tenant inexistente; 400 uuid inválido", async () => {
		f = await fixture();
		const fix = await fx();
		const missing = await app.request(
			`/v1/admin/tenants/${crypto.randomUUID()}/billing`,
			{ headers: authedAs(fix.adminToken) },
		);
		expect(missing.status).toBe(404);
		const bad = await app.request("/v1/admin/tenants/abc/billing", {
			headers: authedAs(fix.adminToken),
		});
		expect(bad.status).toBe(400);
	});
});

describe("GET /v1/admin/audit-log", () => {
	async function seedLog(targetId: string, what: string, minutesAgo = 0) {
		const fix = await fx();
		await sqlx`
			INSERT INTO admin_audit_log
				(who_user_id, what, target_type, target_id, metadata, occurred_at, ip)
			VALUES (${fix.adminUserId}, ${what}, 'tenant', ${targetId}, '{}',
				now() - (${`${minutesAgo} minutes`}::interval), '198.51.100.1')`;
	}

	it("paginação e ordenação occurred_at DESC; who seguro", async () => {
		f = await fixture();
		const fix = await fx();
		await seedLog(fix.tenantId, "tenant.suspended", 10);
		await seedLog(fix.tenantId, "tenant.reactivated", 5);
		const res = await app.request("/v1/admin/audit-log?page_size=1", {
			headers: authedAs(fix.adminToken),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			items: {
				what: string;
				who: { email: string | null };
				occurred_at: string;
			}[];
			total: number;
			page_size: number;
		};
		expect(json.total).toBeGreaterThanOrEqual(2);
		expect(json.items.length).toBe(1);
		expect(json.items[0]?.what).toBe("tenant.reactivated");
		expect(json.items[0]?.who.email).toBe(`${fix.adminToken}@t.com`);
	});

	it("filtros tenant_id, who_user_id, what e período from/to", async () => {
		f = await fixture();
		const fix = await fx();
		await seedLog(fix.tenantId, "tenant.suspended");

		const byTenant = await app.request(
			`/v1/admin/audit-log?tenant_id=${fix.tenantId}`,
			{ headers: authedAs(fix.adminToken) },
		);
		const byTenantJson = (await byTenant.json()) as { items: unknown[] };
		expect(byTenantJson.items.length).toBeGreaterThanOrEqual(1);

		const byWho = await app.request(
			`/v1/admin/audit-log?who_user_id=${fix.adminUserId}`,
			{ headers: authedAs(fix.adminToken) },
		);
		const byWhoJson = (await byWho.json()) as { items: unknown[] };
		expect(byWhoJson.items.length).toBeGreaterThanOrEqual(1);

		const byWhat = await app.request(
			"/v1/admin/audit-log?what=tenant.suspended",
			{
				headers: authedAs(fix.adminToken),
			},
		);
		const byWhatJson = (await byWhat.json()) as { items: unknown[] };
		expect(byWhatJson.items.length).toBeGreaterThanOrEqual(1);

		const none = await app.request(
			`/v1/admin/audit-log?what=tenant.suspended&tenant_id=${crypto.randomUUID()}`,
			{ headers: authedAs(fix.adminToken) },
		);
		const noneJson = (await none.json()) as { items: unknown[] };
		expect(noneJson.items.length).toBe(0);

		const now = Date.now();
		const period = await app.request(
			`/v1/admin/audit-log?from=${new Date(now - 3600_000).toISOString()}&to=${new Date(now + 3600_000).toISOString()}`,
			{ headers: authedAs(fix.adminToken) },
		);
		const periodJson = (await period.json()) as { items: unknown[] };
		expect(periodJson.items.length).toBeGreaterThanOrEqual(1);
	});

	it("400: from>to, período>90d, datas/uuid inválidos, what longo, paginação", async () => {
		f = await fixture();
		const fix = await fx();
		const get = (qs: string) =>
			app.request(`/v1/admin/audit-log?${qs}`, {
				headers: authedAs(fix.adminToken),
			});
		expect(
			(await get("from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z")).status,
		).toBe(400);
		expect(
			(await get("from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z")).status,
		).toBe(400);
		expect((await get("from=xx")).status).toBe(400);
		expect((await get("to=yy")).status).toBe(400);
		expect((await get("tenant_id=nope")).status).toBe(400);
		expect((await get("who_user_id=nope")).status).toBe(400);
		expect((await get(`what=${"w".repeat(81)}`)).status).toBe(400);
		expect((await get("page=0")).status).toBe(400);
	});
});

describe("bloqueio de tenant suspenso (decisão #5)", () => {
	it("POST /v1/auth/sync → 403 'tenant suspenso' p/ usuário suspenso", async () => {
		f = await fixture();
		const fix = await fx();
		await sqlx`UPDATE businesses SET suspended_at = now() WHERE id = ${fix.tenantId}`;
		const res = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...authedAs(fix.ownerToken),
			},
			body: JSON.stringify({ name: "Owner" }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe(
			"tenant suspenso",
		);
	});

	it("POST /v1/services → 201 ativo; 403 suspenso (bloqueio em rota tenant)", async () => {
		f = await fixture();
		const fix = await fx();
		const payload = {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...authedAs(fix.ownerToken),
			},
			body: JSON.stringify({
				name: "Corte",
				duration_min: 30,
				price_cents: 5000,
			}),
		};
		const ok = await app.request("/v1/services", payload);
		expect(ok.status).toBe(201);

		await sqlx`UPDATE businesses SET suspended_at = now() WHERE id = ${fix.tenantId}`;
		const blocked = await app.request("/v1/services", payload);
		expect(blocked.status).toBe(403);
	});

	it("GET /v1/me (leitura) também bloqueado p/ suspenso", async () => {
		f = await fixture();
		const fix = await fx();
		await sqlx`UPDATE businesses SET suspended_at = now() WHERE id = ${fix.tenantId}`;
		const res = await app.request("/v1/me", {
			headers: authedAs(fix.ownerToken),
		});
		expect(res.status).toBe(403);
	});

	it("usuário sem espelho no banco passa (auth/sync cria 1º acesso)", async () => {
		f = await fixture();
		const fresh = uid();
		const res = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...authedAs(fresh),
			},
			body: JSON.stringify({ name: "Novo" }),
		});
		expect([200, 201]).toContain(res.status);
		await sqlx`DELETE FROM users WHERE firebase_uid = ${fresh}`;
		await sqlx`DELETE FROM businesses WHERE name = 'Novo'`;
	});

	it("admin do tenant interno suspenso continua 200 (guard roda antes)", async () => {
		f = await fixture();
		const fix = await fx();
		await sqlx`UPDATE businesses SET suspended_at = now() WHERE id = ${fix.internalId}`;
		const res = await app.request("/v1/admin/tenants", {
			headers: authedAs(fix.adminToken),
		});
		expect(res.status).toBe(200);
	});
});

describe("append-only do admin_audit_log (trigger do banco)", () => {
	it("UPDATE e DELETE rejeitados", async () => {
		f = await fixture();
		const fix = await fx();
		await sqlx`
			INSERT INTO admin_audit_log
				(who_user_id, what, target_type, target_id, metadata, occurred_at, ip)
			VALUES (${fix.adminUserId}, 'tenant.suspended', 'tenant', ${fix.tenantId}, '{}', now(), 'x')`;
		await expect(
			sqlx`UPDATE admin_audit_log SET what = 'hack' WHERE target_id = ${fix.tenantId}`,
		).rejects.toThrow("append-only");
		await expect(
			sqlx`DELETE FROM admin_audit_log WHERE target_id = ${fix.tenantId}`,
		).rejects.toThrow("append-only");
	});
});

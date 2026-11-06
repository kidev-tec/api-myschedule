/**
 * Integração REAL (0026): tipo da conta e códigos do módulo agregador.
 * GET /me (account_kind, pro_code, aggregator_code) + PUT /me/account-kind.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-akind-${Date.now()}-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (t: string) => {
		if (t !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro AKind" };
	});
	return { Authorization: `Bearer ${u}` };
}

async function syncUser(h: Record<string, string>) {
	const r = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro AKind ${Date.now()}-${seq++}` }),
	});
	return (await r.json()) as {
		user: { id: string };
		business: { id: string };
	};
}

type Me = {
	account_kind: string;
	pro_code: string;
	aggregator_code: string | null;
	onboarding_complete: boolean;
};
async function me(h: Record<string, string>) {
	const r = await app.request("/v1/me", { headers: h });
	return (await r.json()) as Me;
}
function setKind(h: Record<string, string>, body: unknown) {
	return app.request("/v1/me/account-kind", {
		method: "PUT",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify(body),
	});
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	try {
		await sql`DELETE FROM professional_links WHERE aggregator_business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro AKind%')`;
		await sql`DELETE FROM users WHERE email LIKE 'test-uid-akind-%'`;
		await sql`DELETE FROM businesses WHERE name LIKE 'Pro AKind%'`;
	} catch {
		// registro apagado por outro worker — ok
	}
	await sql.end();
});

describe("tipo da conta (account_kind) e códigos", () => {
	it("conta nova é independente, com código de profissional e sem código de estabelecimento", async () => {
		const h = authed(uid());
		await syncUser(h);
		const m = await me(h);
		expect(m.account_kind).toBe("independent");
		expect(m.pro_code).toMatch(/^P-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
		expect(m.aggregator_code).toBeNull();
		// independente sem serviço/horário: onboarding ainda incompleto
		expect(m.onboarding_complete).toBe(false);
	});

	it("códigos de profissional são únicos por usuário", async () => {
		const a = authed(uid());
		await syncUser(a);
		const codeA = (await me(a)).pro_code;
		const b = authed(uid());
		await syncUser(b);
		const codeB = (await me(b)).pro_code;
		expect(codeA).not.toBe(codeB);
	});

	it("promove a agregador: gera código E- e onboarding não exige serviço/horário (D4)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const r = await setKind(h, { account_kind: "aggregator" });
		expect(r.status).toBe(200);
		const body = (await r.json()) as {
			account_kind: string;
			aggregator_code: string;
		};
		expect(body.account_kind).toBe("aggregator");
		expect(body.aggregator_code).toMatch(
			/^E-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/,
		);
		const m = await me(h);
		expect(m.account_kind).toBe("aggregator");
		expect(m.aggregator_code).toBe(body.aggregator_code);
		expect(m.onboarding_complete).toBe(true);
	});

	it("promover de novo é idempotente e mantém o mesmo código", async () => {
		const h = authed(uid());
		await syncUser(h);
		const first = (await (
			await setKind(h, { account_kind: "aggregator" })
		).json()) as { aggregator_code: string };
		const again = await setKind(h, { account_kind: "aggregator" });
		expect(again.status).toBe(200);
		expect(
			((await again.json()) as { aggregator_code: string }).aggregator_code,
		).toBe(first.aggregator_code);
	});

	it("volta a independente sem vínculos e reaproveita o código ao promover de novo (D1)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const first = (await (
			await setKind(h, { account_kind: "aggregator" })
		).json()) as { aggregator_code: string };
		const back = await setKind(h, { account_kind: "independent" });
		expect(back.status).toBe(200);
		const m = await me(h);
		expect(m.account_kind).toBe("independent");
		// código fica guardado, mas só é exposto enquanto for agregador
		expect(m.aggregator_code).toBeNull();
		const again = (await (
			await setKind(h, { account_kind: "aggregator" })
		).json()) as { aggregator_code: string };
		expect(again.aggregator_code).toBe(first.aggregator_code);
	});

	it("não volta a independente com vínculo ativo ou pendente (D1)", async () => {
		const proUid = uid();
		const proData = await syncUser(authed(proUid));
		const aggUid = uid();
		const agg = authed(aggUid);
		const aggData = await syncUser(agg);
		await setKind(agg, { account_kind: "aggregator" });
		for (const status of ["pending", "active"]) {
			await sql`DELETE FROM professional_links WHERE aggregator_business_id = ${aggData.business.id}`;
			await sql`
        INSERT INTO professional_links (aggregator_business_id, professional_user_id, status, requested_by)
        VALUES (${aggData.business.id}, ${proData.user.id}, ${status}, 'aggregator')`;
			const r = await setKind(agg, { account_kind: "independent" });
			expect(r.status).toBe(409);
			expect(((await r.json()) as { error: string }).error).toMatch(
				/profissionais vinculados/,
			);
		}
		// vínculo encerrado não impede
		await sql`UPDATE professional_links SET status = 'ended' WHERE aggregator_business_id = ${aggData.business.id}`;
		expect((await setKind(agg, { account_kind: "independent" })).status).toBe(
			200,
		);
	});

	it("valor inválido → 400 com mensagem em português", async () => {
		const h = authed(uid());
		await syncUser(h);
		for (const body of [{ account_kind: "salao" }, {}, null]) {
			const r = await setKind(h, body);
			expect(r.status).toBe(400);
			expect(((await r.json()) as { error: string }).error).toBe(
				"Tipo de conta inválido",
			);
		}
		const broken = await app.request("/v1/me/account-kind", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: "{quebrado",
		});
		expect(broken.status).toBe(400);
	});
});

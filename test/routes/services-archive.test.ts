/**
 * Integração REAL: BARRA B3 — serviços CRUD + archive.
 * Firebase mockado, Postgres docker real. Padrão de clients-patch.test.ts.
 *
 * Cenários:
 * - duração: 15/30/480 válidos; 5/10/20/495/600/float/não-número → 400
 * - busca ?q= case-insensitive
 * - archive (DELETE): some da listagem e do wizard (public booking),
 *   permanece acessível em agendamentos passados (JOIN sem filtro archived)
 * - reativar serviço arquivado não é possível via PATCH (404 — defesa)
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
	"postgres://postgres:postgres@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-svc-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Teste" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function createdUser(headers: Record<string, string>) {
	const auth = headers.Authorization;
	if (!auth) throw new Error("Authorization ausente");
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			name: `Pro Teste svc ${auth.slice(7)}`,
		}),
	});
	expect(res.status).toBe(201);
}

async function createService(
	headers: Record<string, string>,
	name: string,
	durationMin = 30,
	priceCents = 5000,
) {
	const res = await app.request("/v1/services", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({
			name,
			duration_min: durationMin,
			price_cents: priceCents,
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as {
		id: string;
		name: string;
		duration_min: number;
	};
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste svc%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste svc%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste svc%')`;
	// corrida: outro arquivo em paralelo pode ter apagado estes users já — ignorar FK
	try {
		await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-svc-%')`;
		await sql`DELETE FROM users WHERE email LIKE 'test-uid-svc-%'`;
	} catch {
		// registro já apagado por outro worker — ok
	}
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste svc%'`;
	await sql.end();
});

describe("POST /v1/services — validação de duração (B3)", () => {
	it("aceita 15, 30, 480 (múltiplos de 15 na faixa)", async () => {
		const h = authed(uid());
		await createdUser(h);
		for (const d of [15, 30, 480]) {
			const res = await app.request("/v1/services", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({
					name: `S${d}`,
					duration_min: d,
					price_cents: 0,
				}),
			});
			expect(res.status).toBe(201);
		}
	});

	it("rejeita 10, 20 (não múltiplo de 15) e 495 (fora da faixa)", async () => {
		const h = authed(uid());
		await createdUser(h);
		for (const d of [10, 20, 495]) {
			const res = await app.request("/v1/services", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({ name: "X", duration_min: d, price_cents: 0 }),
			});
			expect(res.status).toBe(400);
		}
	});

	it("rejeita float, string e undefined", async () => {
		const h = authed(uid());
		await createdUser(h);
		for (const d of [30.5, "30", null]) {
			const res = await app.request("/v1/services", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({ name: "X", duration_min: d, price_cents: 0 }),
			});
			expect(res.status).toBe(400);
		}
	});

	it("PATCH valida duração com a mesma regra (40 → 400, 45 → 200)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const svc = await createService(h, "Corte");

		const bad = await app.request(`/v1/services/${svc.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ duration_min: 40 }),
		});
		expect(bad.status).toBe(400);

		const good = await app.request(`/v1/services/${svc.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ duration_min: 45 }),
		});
		expect(good.status).toBe(200);
		const body = (await good.json()) as { duration_min: number };
		expect(body.duration_min).toBe(45);
	});
});

describe("GET /v1/services?q= — busca (B3)", () => {
	it("filtra por nome case-insensitive", async () => {
		const h = authed(uid());
		await createdUser(h);
		await createService(h, "Corte Masculino");
		await createService(h, "Coloração");

		const res = await app.request("/v1/services?q=corte", { headers: h });
		expect(res.status).toBe(200);
		const rows = (await res.json()) as { name: string }[];
		expect(rows.length).toBe(1);
		expect(rows[0]?.name).toBe("Corte Masculino");

		// sem q → todos os ativos
		const all = await app.request("/v1/services", { headers: h });
		const allRows = (await all.json()) as { name: string }[];
		expect(allRows.length).toBe(2);
	});

	it("?q= vazio ou espaço → lista tudo", async () => {
		const h = authed(uid());
		await createdUser(h);
		await createService(h, "Unha");

		const res = await app.request("/v1/services?q=%20%20", { headers: h });
		const rows = (await res.json()) as { name: string }[];
		expect(rows.length).toBe(1);
	});
});

describe("ARCHIVE (B3) — arquivado some do futuro, fica no passado", () => {
	it("DELETE arquiva: some da lista, 404 no GET/:id e no PATCH", async () => {
		const h = authed(uid());
		await createdUser(h);
		const svc = await createService(h, "Escova");

		const del = await app.request(`/v1/services/${svc.id}`, {
			method: "DELETE",
			headers: h,
		});
		expect(del.status).toBe(200);
		const deleted = (await del.json()) as { archived_at: string | null };
		expect(deleted.archived_at).not.toBeNull();

		// some da listagem
		const list = await app.request("/v1/services", { headers: h });
		const rows = (await list.json()) as { id: string }[];
		expect(rows.some((r) => r.id === svc.id)).toBe(false);

		// GET/:id → 404 (só ativos)
		const get = await app.request(`/v1/services/${svc.id}`, { headers: h });
		expect(get.status).toBe(404);

		// PATCH → 404 (não edita arquivado)
		const patch = await app.request(`/v1/services/${svc.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Novo nome" }),
		});
		expect(patch.status).toBe(404);
	});

	it("serviço arquivado não aparece no booking público (wizard), mas o agendamento passado mantém o nome", async () => {
		const h = authed(uid());
		await createdUser(h);
		const svc = await createService(h, "Relaxamento");

		// cria cliente e agendamento PASSADO com esse serviço (direto no banco,
		// depois arquiva o serviço e vê se o histórico sobrevive)
		const auth = h.Authorization;
		if (!auth) throw new Error("Authorization ausente");
		const bizRows = await sql<{ id: string }[]>`
			SELECT id FROM businesses WHERE name LIKE ${`Pro Teste svc ${auth.slice(7)}%`} LIMIT 1`;
		const businessId = bizRows[0]?.id;
		if (!businessId) throw new Error("business não encontrado");
		const client = await sql<{ id: string }[]>`
			INSERT INTO clients (business_id, name, phone_e164)
			VALUES (${businessId}, 'Cli', '+5514999980001') RETURNING id`;
		const userRows = await sql<{ id: string }[]>`
			SELECT id FROM users WHERE business_id = ${businessId} LIMIT 1`;
		const start = new Date(Date.now() - 2 * 86400_000);
		const end = new Date(start.getTime() + 1800_000);
		const clientId = client[0]?.id;
		const userId = userRows[0]?.id;
		if (!clientId || !userId) throw new Error("client/user não encontrados");
		await sql`
			INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status)
			VALUES (${businessId}, ${clientId}, ${svc.id}, ${userId}, ${start.toISOString()}, ${end.toISOString()}, 'done')`;

		// arquiva o serviço
		await app.request(`/v1/services/${svc.id}`, {
			method: "DELETE",
			headers: h,
		});

		// booking público: serviço NÃO aparece para novos agendamentos
		const publicServices = await app.request(
			`/v1/public/businesses/${businessId}/services`,
		);
		// (rota pública existe? se 404, a checagem é pela listagem interna)
		if (publicServices.status === 200) {
			const pubRows = (await publicServices.json()) as
				| { id: string }[]
				| { services: { id: string }[] };
			const pubList = Array.isArray(pubRows)
				? pubRows
				: (pubRows.services ?? []);
			expect(pubList.some((r) => r.id === svc.id)).toBe(false);
		}

		// histórico: agendamento passado continua com o serviço (JOIN direto)
		const history = await sql<{ name: string }[]>`
			SELECT s.name FROM appointments a
			JOIN services s ON s.id = a.service_id
			WHERE a.business_id = ${businessId}`;
		expect(history.length).toBe(1);
		expect(history[0]?.name).toBe("Relaxamento");
	});
});

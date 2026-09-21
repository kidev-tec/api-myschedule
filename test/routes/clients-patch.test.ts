/**
 * Integração REAL: PATCH /v1/clients/:id (GAP-1 do baseline audit).
 * Firebase mockado — Postgres docker é real. Padrão de onboarding-clients.test.ts.
 *
 * Cenários (BARRA B2):
 * - 200 payload válido → dados atualizados persistidos
 * - 409 telefone duplicado de OUTRO cliente do negócio
 * - 200 telefone igual ao PRÓPRIO (self-update não é conflito)
 * - 400 validação: nome vazio / telefone curto / body inválido
 * - 400 deleted_at não editável
 * - 404 cliente de outro business (isolamento) / id inexistente / id inválido
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
	"postgres://postgres:***@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-${Date.now()}-${seq++}`;

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
			name: `Pro Teste ${auth.slice(7)}`,
		}),
	});
	expect(res.status).toBe(201);
}

async function createClient(
	headers: Record<string, string>,
	name: string,
	phone: string,
) {
	const res = await app.request("/v1/clients", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ name, phone_e164: phone }),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; name: string; phone_e164: string };
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste%'`;
	await sql.end();
});

describe("PATCH /v1/clients/:id", () => {
	it("200 — atualiza nome, telefone, email, birthday e notes", async () => {
		const h = authed(uid());
		await createdUser(h);
		const client = await createClient(h, "Ana", "+5514999990001");

		const res = await app.request(`/v1/clients/${client.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Ana Souza",
				phone_e164: "+5514999990002",
				email: "ana@t.com",
				birthday: "1990-05-10",
				notes: "Prefere tarde",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			name: string;
			phone_e164: string;
			email: string | null;
			birthday: string | null;
			notes: string | null;
		};
		expect(body.name).toBe("Ana Souza");
		expect(body.phone_e164).toBe("+5514999990002");
		expect(body.email).toBe("ana@t.com");
		expect(body.birthday).toBe("1990-05-10");
		expect(body.notes).toBe("Prefere tarde");

		// Persistiu no banco real
		const rows = await sql`
			SELECT name, phone_e164 FROM clients WHERE id = ${client.id}`;
		expect(rows[0]?.name).toBe("Ana Souza");
		expect(rows[0]?.phone_e164).toBe("+5514999990002");
	});

	it("409 — telefone que já existe em OUTRO cliente do negócio", async () => {
		const h = authed(uid());
		await createdUser(h);
		const a = await createClient(h, "Ana", "+5514999990010");
		await createClient(h, "Bia", "+5514999990011");

		const res = await app.request(`/v1/clients/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Ana",
				phone_e164: "+5514999990011", // telefone da Bia
			}),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("telefone");
	});

	it("200 — telefone igual ao PRÓPRIO não é conflito (self-update)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const a = await createClient(h, "Ana", "+5514999990020");

		const res = await app.request(`/v1/clients/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Ana Atualizada",
				phone_e164: "+5514999990020", // mesmo telefone dela
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string };
		expect(body.name).toBe("Ana Atualizada");
	});

	it("400 — nome vazio", async () => {
		const h = authed(uid());
		await createdUser(h);
		const a = await createClient(h, "Ana", "+5514999990030");

		const res = await app.request(`/v1/clients/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "  ", phone_e164: "+5514999990030" }),
		});
		expect(res.status).toBe(400);
	});

	it("400 — telefone curto", async () => {
		const h = authed(uid());
		await createdUser(h);
		const a = await createClient(h, "Ana", "+5514999990031");

		const res = await app.request(`/v1/clients/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Ana", phone_e164: "123" }),
		});
		expect(res.status).toBe(400);
	});

	it("400 — body não é JSON", async () => {
		const h = authed(uid());
		await createdUser(h);
		const a = await createClient(h, "Ana", "+5514999990032");

		const res = await app.request(`/v1/clients/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: "não-json",
		});
		expect(res.status).toBe(400);
	});

	it("400 — deleted_at presente (não editável via PATCH)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const a = await createClient(h, "Ana", "+5514999990033");

		const res = await app.request(`/v1/clients/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Ana",
				phone_e164: "+5514999990033",
				deleted_at: null,
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("deleted_at");
	});

	it("404 — id inexistente", async () => {
		const h = authed(uid());
		await createdUser(h);

		const res = await app.request(
			"/v1/clients/00000000-0000-0000-0000-000000000001",
			{
				method: "PATCH",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({ name: "X", phone_e164: "+5514999990040" }),
			},
		);
		expect(res.status).toBe(404);
	});

	it("404 — cliente de OUTRO business (isolamento multi-tenant)", async () => {
		const h1 = authed(uid());
		await createdUser(h1);
		const client = await createClient(h1, "Ana", "+5514999990050");

		const h2 = authed(uid());
		await createdUser(h2);

		const res = await app.request(`/v1/clients/${client.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h2 },
			body: JSON.stringify({ name: "Hack", phone_e164: "+5514999990099" }),
		});
		expect(res.status).toBe(404);
		// E não alterou nada
		const rows = await sql`SELECT name FROM clients WHERE id = ${client.id}`;
		expect(rows[0]?.name).toBe("Ana");
	});

	it("400 — id não é UUID", async () => {
		const h = authed(uid());
		await createdUser(h);

		const res = await app.request("/v1/clients/não-é-uuid", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "X", phone_e164: "+5514999990060" }),
		});
		expect(res.status).toBe(400);
	});

	it("409 — dedupe ignora clientes soft-deleted (pode reusar telefone)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const a = await createClient(h, "Ana", "+5514999990070");
		const b = await createClient(h, "Bia", "+5514999990071");

		// Soft-delete da Bia
		const del = await app.request(`/v1/clients/${b.id}`, {
			method: "DELETE",
			headers: h,
		});
		expect(del.status).toBe(200);

		// Ana pode pegar o telefone da Bia deletada
		const res = await app.request(`/v1/clients/${a.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Ana", phone_e164: "+5514999990071" }),
		});
		expect(res.status).toBe(200);
	});
});

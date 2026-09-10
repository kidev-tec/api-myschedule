/**
 * RF-08 — espelho two-way no Google Calendar (mirrorToCalendar).
 *
 * Fluxo real exercido contra Postgres de teste, Google mockado via fetch:
 * - confirmado sem evento → POST cria e salva gcal_event_id
 * - remarcação (PATCH de horário) → PATCH atualiza o evento
 * - cancelamento → DELETE remove e limpa o id
 * - evento apagado manualmente no Calendar (404) → recria
 * - GCal desconectado → no-op
 */

import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

import { createApp } from "../../src/app.js";
import { mirrorToCalendar } from "../../src/domain/gcal-mirror.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:postgres@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const RUN = Date.now();
let uid = "";
let h: Record<string, string>;

async function setupProfessional(name: string, refreshToken: string | null) {
	uid = `gcalmirror-${name}-${RUN}`;
	const tokenHeader: Record<string, string> = {
		Authorization: `Bearer ${uid}`,
	};
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uid) throw new Error("invalid");
		return { uid, email: `${uid}@t.com`, name };
	});
	await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...tokenHeader },
		body: JSON.stringify({ name }),
	});
	if (refreshToken !== null) {
		await sql`update businesses set gcal_refresh_token = ${refreshToken} where name = ${name}`;
	}
	h = tokenHeader;
}

async function createFixture(): Promise<{
	clientId: string;
	serviceId: string;
}> {
	// cliente + serviço + working hours, tudo pela API (rotas reais)
	const cRes = await app.request("/v1/clients", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({
			name: "Cliente GCal",
			phone_e164: "+5514999990001",
		}),
	});
	const cBody = (await cRes.json()) as { id?: string };
	const sRes = await app.request("/v1/services", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({
			name: "Corte",
			duration_min: 30,
			price_cents: 5000,
		}),
	});
	const sBody = (await sRes.json()) as { id?: string };
	if (!cBody.id || !sBody.id) {
		throw new Error(
			`fixture falhou: clients ${cRes.status} services ${sRes.status}`,
		);
	}
	return { clientId: cBody.id, serviceId: sBody.id };
}

async function bookTomorrow(hourUtc: number) {
	const { clientId, serviceId } = await createFixture();
	const start = new Date();
	start.setUTCDate(start.getUTCDate() + 1);
	start.setUTCHours(hourUtc, 0, 0, 0);
	const end = new Date(start.getTime() + 30 * 60_000);
	const res = await app.request("/v1/appointments", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({
			clientId,
			serviceId,
			startsAt: start.toISOString(),
			endsAt: end.toISOString(),
		}),
	});
	const body = (await res.json()) as { appointment?: { id?: string } };
	if (!body.appointment?.id) {
		throw new Error(`booking falhou: ${res.status} ${JSON.stringify(body)}`);
	}
	return { id: body.appointment.id, start, end };
}

/** fetchMock: refresh token → AT, criação de evento → id EVT-n */
function mockGoogle(eventId: string) {
	fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("oauth2.googleapis.com/token")) {
			return Response.json({ access_token: "AT-1" });
		}
		if (init?.method === "POST" && u.includes("/events")) {
			return Response.json({ id: eventId, htmlLink: "https://cal/x" });
		}
		if (init?.method === "PATCH" && u.includes("/events/")) {
			return Response.json({ id: eventId });
		}
		if (init?.method === "DELETE" && u.includes("/events/")) {
			return new Response(null, { status: 204 });
		}
		return new Response("unexpected fetch", { status: 500 });
	});
}

async function eventRow(id: string) {
	const rows = await sql`
		select gcal_event_id, status, starts_at, ends_at
		from appointments where id = ${id}`;
	return rows[0];
}

beforeEach(async () => {
	fetchMock.mockReset();
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Mirror %')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Mirror %')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Mirror %')`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'gcalmirror-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'gcalmirror-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Mirror %'`;
	await sql.end();
});

describe("RF-08: espelho two-way no Calendar", () => {
	it("confirmado → cria evento e salva gcal_event_id", async () => {
		await setupProfessional(`Mirror Create ${RUN}`, "RT-create");
		await createFixture();
		const { id } = await bookTomorrow(14);

		mockGoogle("EVT-create-1");
		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		expect(res.status).toBe(200);

		// fire-and-forget: aguarda o microtask do espelho
		await new Promise((r) => setTimeout(r, 50));
		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBe("EVT-create-1");

		// evento criado com corpo certo (summary = serviço — cliente)
		const createCall = fetchMock.mock.calls.find(
			([u, i]) => String(u).includes("/events") && i?.method === "POST",
		);
		const body = JSON.parse(createCall?.[1].body as string);
		expect(body.summary).toBe("Corte — Cliente GCal");
		expect(body.description).toContain("+5514999990001");
	});

	it("remarcação de confirmado → PATCH atualiza o evento", async () => {
		await setupProfessional(`Mirror Move ${RUN}`, "RT-move");
		await createFixture();
		const { id } = await bookTomorrow(15);
		mockGoogle("EVT-move-1");
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		await new Promise((r) => setTimeout(r, 50));

		fetchMock.mockClear();
		mockGoogle("EVT-move-1");
		const newStart = new Date();
		newStart.setUTCDate(newStart.getUTCDate() + 1);
		newStart.setUTCHours(18, 0, 0, 0);
		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				startsAt: newStart.toISOString(),
				endsAt: new Date(newStart.getTime() + 30 * 60_000).toISOString(),
			}),
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));

		const patchCall = fetchMock.mock.calls.find(
			([u, i]) => String(u).includes("EVT-move-1") && i?.method === "PATCH",
		);
		expect(patchCall).toBeTruthy();
		const body = JSON.parse(patchCall?.[1].body as string);
		expect(body.start.dateTime).toContain(
			newStart.toISOString().slice(11, 13) === "18" ? "1800" : "",
		);
	});

	it("cancelamento de confirmado → DELETE do evento e id limpo", async () => {
		await setupProfessional(`Mirror Cancel ${RUN}`, "RT-cancel");
		await createFixture();
		const { id } = await bookTomorrow(16);
		mockGoogle("EVT-cancel-1");
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		await new Promise((r) => setTimeout(r, 50));

		fetchMock.mockClear();
		mockGoogle("EVT-cancel-1");
		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "canceled" }),
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));

		const delCall = fetchMock.mock.calls.find(
			([u, i]) => String(u).includes("EVT-cancel-1") && i?.method === "DELETE",
		);
		expect(delCall).toBeTruthy();
		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBeNull();
	});

	it("evento apagado manualmente no Calendar (404 no PATCH) → recria", async () => {
		await setupProfessional(`Mirror Gone ${RUN}`, "RT-gone");
		await createFixture();
		const { id } = await bookTomorrow(17);
		mockGoogle("EVT-gone-1");
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		await new Promise((r) => setTimeout(r, 50));

		// Google responde 404 no update (evento deletado no Calendar) e 201 na recriação
		fetchMock.mockReset();
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("oauth2.googleapis.com/token")) {
				return Response.json({ access_token: "AT-2" });
			}
			if (init?.method === "PATCH") {
				return new Response("gone", { status: 404 });
			}
			if (init?.method === "POST" && u.includes("/events")) {
				return Response.json({ id: "EVT-gone-2" });
			}
			return new Response("unexpected", { status: 500 });
		});

		const newStart = new Date();
		newStart.setUTCDate(newStart.getUTCDate() + 1);
		newStart.setUTCHours(19, 0, 0, 0);
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				startsAt: newStart.toISOString(),
				endsAt: new Date(newStart.getTime() + 30 * 60_000).toISOString(),
			}),
		});
		await new Promise((r) => setTimeout(r, 50));

		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBe("EVT-gone-2");
	});

	it("GCal desconectado → PATCH funciona sem chamar o Google", async () => {
		await setupProfessional(`Mirror Off ${RUN}`, null);
		await createFixture();
		const { id } = await bookTomorrow(20);

		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));
		expect(fetchMock).not.toHaveBeenCalled();
		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBeNull();
	});

	it("token refresh recusado pelo Google → mirror lança sem quebrar o PATCH", async () => {
		await setupProfessional(`Mirror TokFail ${RUN}`, "RT-tokfail");
		await createFixture();
		const { id } = await bookTomorrow(21);
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		await new Promise((r) => setTimeout(r, 50));

		// próxima espelhada (remarcação) com token recusado
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(new Response("denied", { status: 400 }));
		const newStart = new Date();
		newStart.setUTCDate(newStart.getUTCDate() + 1);
		newStart.setUTCHours(22, 0, 0, 0);
		const res = await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				startsAt: newStart.toISOString(),
				endsAt: new Date(newStart.getTime() + 30 * 60_000).toISOString(),
			}),
		});
		// fire-and-forget: PATCH 200 mesmo com o espelho falhando
		expect(res.status).toBe(200);
		await new Promise((r) => setTimeout(r, 50));
	});

	it("Google recusa criação de evento (500) → erro propagado, sem id salvo", async () => {
		await setupProfessional(`Mirror CreateFail ${RUN}`, "RT-createfail");
		await createFixture();
		const { id } = await bookTomorrow(23);
		fetchMock.mockImplementation(async (url: string) => {
			if (String(url).includes("oauth2.googleapis.com/token")) {
				return Response.json({ access_token: "AT-3" });
			}
			return new Response("boom", { status: 500 });
		});
		await expect(mirrorToCalendar(DATABASE_URL, id)).rejects.toThrow(
			/criar evento falhou/,
		);
		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBeNull();
	});

	it("Google recusa atualização (500) → erro propagado", async () => {
		await setupProfessional(`Mirror UpdFail ${RUN}`, "RT-updfail");
		await createFixture();
		const { id } = await bookTomorrow(0);
		mockGoogle("EVT-updfail");
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		await new Promise((r) => setTimeout(r, 50));
		fetchMock.mockReset();
		fetchMock.mockImplementation(async (url: string) => {
			if (String(url).includes("oauth2.googleapis.com/token")) {
				return Response.json({ access_token: "AT-4" });
			}
			return new Response("boom", { status: 500 });
		});
		await expect(mirrorToCalendar(DATABASE_URL, id)).rejects.toThrow(
			/atualizar evento falhou/,
		);
	});

	it("agendamento inexistente → no-op", async () => {
		await expect(
			mirrorToCalendar(DATABASE_URL, "11111111-1111-4111-8111-111111111111"),
		).resolves.toBeUndefined();
	});

	it("GCAL_CLIENT_ID/SECRET setados → refresh usa as credenciais do env", async () => {
		process.env.GCAL_CLIENT_ID = "cid-teste";
		process.env.GCAL_CLIENT_SECRET = "csecret-teste";
		await setupProfessional(`Mirror EnvCreds ${RUN}`, "RT-envcreds");
		await createFixture();
		const { id } = await bookTomorrow(13);
		mockGoogle("EVT-envcreds");
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		await new Promise((r) => setTimeout(r, 50));
		const tokCall = fetchMock.mock.calls.find(([u]) =>
			String(u).includes("oauth2.googleapis.com/token"),
		);
		const sent = new URLSearchParams(tokCall![1].body as string);
		expect(sent.get("client_id")).toBe("cid-teste");
		delete process.env.GCAL_CLIENT_ID;
		delete process.env.GCAL_CLIENT_SECRET;
		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBe("EVT-envcreds");
	});

	it("cliente sem telefone → evento criado sem parênteses na descrição", async () => {
		await setupProfessional(`Mirror NoPhone ${RUN}`, "RT-nophone");
		// cliente SEM phone na criação não é possível (obrigatório) — cria e zera
		const { clientId, serviceId } = await createFixture();
		await sql`update clients set phone_e164 = '' where id = ${clientId}`;
		const start = new Date();
		start.setUTCDate(start.getUTCDate() + 1);
		start.setUTCHours(10, 0, 0, 0);
		const res = await app.request("/v1/appointments", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				clientId,
				serviceId,
				startsAt: start.toISOString(),
				endsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
			}),
		});
		const body = (await res.json()) as { appointment?: { id?: string } };
		const id = body.appointment!.id!;
		fetchMock.mockReset();
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (String(url).includes("oauth2.googleapis.com/token")) {
				return Response.json({ access_token: "AT-5" });
			}
			if (init?.method === "POST" && String(url).includes("/events")) {
				return Response.json({ id: "EVT-nophone" });
			}
			return new Response("unexpected", { status: 500 });
		});
		await mirrorToCalendar(DATABASE_URL, id);
		const createCall = fetchMock.mock.calls.find(
			([u, i]) => String(u).includes("/events") && i?.method === "POST",
		);
		const evt = JSON.parse(createCall![1].body as string);
		expect(evt.description).not.toContain("()");
		expect(evt.description).toContain("Cliente: Cliente GCal\n");
	});

	it("Google devolve 201 sem id → mirror falha sem salvar evento", async () => {
		await setupProfessional(`Mirror NoId ${RUN}`, "RT-noid");
		await createFixture();
		const { id } = await bookTomorrow(11);
		fetchMock.mockImplementation(async (url: string) => {
			if (String(url).includes("oauth2.googleapis.com/token")) {
				return Response.json({ access_token: "AT-6" });
			}
			return Response.json({ htmlLink: "sem-id" });
		});
		await expect(mirrorToCalendar(DATABASE_URL, id)).rejects.toThrow(
			/evento criado sem id/,
		);
		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBeNull();
	});

	it("DELETE do evento falha (500) → id preservado pra tentar de novo", async () => {
		await setupProfessional(`Mirror DelFail ${RUN}`, "RT-delfail");
		await createFixture();
		const { id } = await bookTomorrow(12);
		mockGoogle("EVT-delfail");
		await app.request(`/v1/appointments/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ status: "confirmed" }),
		});
		await new Promise((r) => setTimeout(r, 50));
		// cancela direto no banco (sem disparar o espelho)
		await sql`update appointments set status = 'canceled' where id = ${id}`;
		fetchMock.mockReset();
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (String(url).includes("oauth2.googleapis.com/token")) {
				return Response.json({ access_token: "AT-7" });
			}
			if (init?.method === "DELETE") {
				return new Response("boom", { status: 500 });
			}
			return new Response("unexpected", { status: 500 });
		});
		await mirrorToCalendar(DATABASE_URL, id);
		const row = await eventRow(id);
		expect(row?.gcal_event_id).toBe("EVT-delfail");
	});
});

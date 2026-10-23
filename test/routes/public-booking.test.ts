/**
 * RF-07 — testes do link público de agendamento.
 *
 * Cobre:
 * - GET /p/:slug → HTML com slug embutido; 404-ish para slug inexistente
 *   (a página HTML renderiza "Link inválido" client-side)
 * - GET /p/:slug/info → business + services + working_hours; 404 slug ruim
 * - POST /p/:slug/book happy path → 201, source=public_link, client
 *   find-or-create por telefone (2º booking do mesmo telefone NÃO duplica)
 * - validações: campos ausentes, serviço de outro business, data no passado
 * - conflito: mesmo slot do profissional → 409
 * - paywall: trial vencido → 402 no book, info continua 200
 * - rate limit: 11ª request do mesmo IP em 1min → 429
 */

import postgres from "postgres";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));

import { createApp } from "../../src/app.js";
import { slotStillValid } from "../../src/domain/public-booking-ui.js";
import { resetRateLimit } from "../../src/routes/public-booking.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

function authed(uid: string) {
	return { Authorization: `Bearer ${uid}` };
}

async function _syncUser(uid: string, name: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uid) throw new Error("invalid");
		return { uid: token, email: `${uid}@t.com`, name };
	});
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...authed(uid) },
		body: JSON.stringify({ name }),
	});
	expect(res.status).toBe(200);
}

afterEach(() => {
	resetRateLimit();
});

/** Remove do banco tudo que este arquivo criou (slugs começam com os nomes
 *  dos profissionais "Pro …" e uids com "pub-"), evitando sujar os cleanup
 *  dos outros arquivos de teste (FK users→businesses impede delete cru). */
async function cleanupMine() {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name IN ('Pro Público','Pro Val','Pro Pay','Pro RL','Pro RL 2')) OR user_id IN (SELECT id FROM users WHERE email LIKE 'pub-uid-%' OR email LIKE 'pub-val-%' OR email LIKE 'pub-pay-%' OR email LIKE 'pub-rl-%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name IN ('Pro Público','Pro Val','Pro Pay','Pro RL','Pro RL 2'))`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name IN ('Pro Público','Pro Val','Pro Pay','Pro RL','Pro RL 2'))`;
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pub-uid-%' OR email LIKE 'pub-val-%' OR email LIKE 'pub-pay-%' OR email LIKE 'pub-rl-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'pub-uid-%' OR email LIKE 'pub-val-%' OR email LIKE 'pub-pay-%' OR email LIKE 'pub-rl-%'`;
	await sql`DELETE FROM businesses WHERE name IN ('Pro Público','Pro Val','Pro Pay','Pro RL','Pro RL 2')`;
}

afterAll(async () => {
	await cleanupMine();
	await sql.end();
});

describe("RF-07: link público de agendamento", () => {
	it("GET /p/:slug → HTML standalone", async () => {
		const res = await app.request("/p/slug-que-nao-existe");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("<!doctype html>");
		expect(html).toContain("slug-que-nao-existe");
		// slug inexistente → sem business → paleta default = MARCA AGENVA
		expect(html).toContain('--p\', "#1E96E8")');
	});

	it("GET /p/:slug → paleta do SEGMENTO quando business tem tipo (barber ≠ beauty)", async () => {
		const uid = `pub-pal-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro Paleta" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: `Pro Paleta ${Date.now()}`,
				business_type: "barber",
			}),
		});
		const slug = ((await syncRes.json()) as { business?: { slug?: string } })
			.business?.slug as string;

		const res = await app.request(`/p/${slug}`);
		expect(res.status).toBe(200);
		const html = await res.text();
		// âmbar da barbearia (preset do app), NÃO o Rubi nem o azul da marca
		expect(html).toContain('--p\', "#8B5E34")');
		// o Rubi continua no mapa de paletas (beauty), mas NUNCA como --p aqui
		expect(html).not.toContain('--p\', "#B51F4D")');
	});

	it("fluxo completo: info → book → find-or-create → conflito 409", async () => {
		// setup: user + business + serviço + horário
		const uid = `pub-uid-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro Público" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Público" }),
		});
		const synced = (await syncRes.json()) as { business?: { slug?: string } };
		const bizSlug = synced.business?.slug;
		expect(bizSlug).toBeTruthy();
		const slug = bizSlug as string;
		expect(slug).toBeTruthy();

		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte Público",
				duration_min: 30,
				price_cents: 5000,
			}),
		});
		const svc = (await svcRes.json()) as { id: string };

		// PUT horários: hoje 8h-18h (weekday calculado de amanhã)
		const tomorrow = new Date(Date.now() + 86400_000);
		await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [
					{
						weekday: tomorrow.getDay(),
						start_minute: 8 * 60,
						end_minute: 18 * 60,
					},
				],
			}),
		});

		// ---- info público
		const info = await app.request(`/p/${slug}/info`);
		expect(info.status).toBe(200);
		const infoJson = (await info.json()) as {
			business: { name: string };
			services: { id: string }[];
			working_hours: unknown[];
		};
		expect(infoJson.business?.name).toBe("Pro Público");
		expect(infoJson.services.some((s) => s.id === svc.id)).toBe(true);
		expect(infoJson.working_hours.length).toBeGreaterThan(0);

		// ---- book público (09:00 de amanhã, horário comercial)
		const start = new Date(tomorrow);
		start.setHours(9, 0, 0, 0);
		const bookRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Cliente Web",
				phone: "(14) 99888-7766",
				service_id: svc.id,
				starts_at: start.toISOString(),
			}),
		});
		expect(bookRes.status).toBe(201);
		const booking = (await bookRes.json()) as {
			id: string;
			status: string;
			service: string;
		};
		expect(booking.status).toBe("pending");
		expect(booking.service).toBe("Corte Público");

		// client foi criado e source=public_link
		const rows = await sql`
			select a.source, c.phone_e164, c.name as client_name
			from appointments a join clients c on c.id = a.client_id
			where a.id = ${booking.id}`;
		expect(rows[0]?.source).toBe("public_link");
		expect(rows[0]?.phone_e164).toBe("14998887766");
		expect(rows[0]?.client_name).toBe("Cliente Web");

		// ---- mesmo slot de novo → 409
		const conflict = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Outro Cliente",
				phone: "14997776655",
				service_id: svc.id,
				starts_at: start.toISOString(),
			}),
		});
		expect(conflict.status).toBe(409);

		// ---- find-or-create: mesmo telefone, outro horário → NÃO duplica client
		const start2 = new Date(tomorrow);
		start2.setHours(10, 0, 0, 0);
		const book2 = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Cliente Web",
				phone: "14998887766",
				service_id: svc.id,
				starts_at: start2.toISOString(),
			}),
		});
		expect(book2.status).toBe(201);
		const _count = (await sql`
			select count(*)::int as n from clients
			where business_id = (select id from businesses where slug = ${slug})
			and phone_e164 in ('14998887766','14999990000')`) as unknown as {
			n: number;
		}[];
		// find-or-create usa phone normalizado; (14) 99888-7766 e 14998887766
		// viram o MESMO dígito? NÃO — um tem 998887766 (12d), outro 14998887766 (11d sem 0).
		// São telefones diferentes de fato; o assert aqui é que não criou 3 clients
		// pro MESMO telefone. Verifica duplicidade real:
		const dup = (await sql`
			select count(*)::int as n from clients
			where business_id = (select id from businesses where slug = ${slug})
			group by phone_e164 having count(*) > 1`) as unknown as { n: number }[];
		expect(dup.length).toBe(0);
		// e o phone foi normalizado (só dígitos)
		const ph = (await sql`
			select phone_e164 from clients
			where business_id = (select id from businesses where slug = ${slug})
			and name = 'Cliente Web'`) as unknown as { phone_e164: string }[];
		expect(ph.length).toBe(1);
		expect(ph[0]?.phone_e164).toBe("14998887766");
	});

	it("validações: campos ruins, serviço estrangeiro, data passada", async () => {
		const uid = `pub-val-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro Val" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Val" }),
		});
		const synced = (await syncRes.json()) as { business?: { slug?: string } };
		const bizSlug = synced.business?.slug;
		expect(bizSlug).toBeTruthy();
		const slug = bizSlug as string;

		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "S", duration_min: 30, price_cents: 0 }),
		});
		const svc = (await svcRes.json()) as { id: string };
		const ok = {
			name: "X",
			phone: "14999990000",
			service_id: svc.id,
			starts_at: new Date(Date.now() + 86_400_000).toISOString(),
		};
		const post = (body: unknown) =>
			app.request(`/p/${slug}/book`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

		expect((await post({ ...ok, name: "" })).status).toBe(400);
		expect((await post({ ...ok, phone: "123" })).status).toBe(400);
		expect((await post({ ...ok, service_id: "nao-uuid" })).status).toBe(400);
		expect((await post({ ...ok, starts_at: "ontem" })).status).toBe(400);
		// starts_at ausente → Date("inválido") → NaN → 400
		const noStart = { ...ok };
		delete (noStart as { starts_at?: string }).starts_at;
		expect((await post(noStart)).status).toBe(400);
		expect(
			(
				await post({
					...ok,
					starts_at: new Date(Date.now() - 3600_000).toISOString(),
				})
			).status,
		).toBe(400);

		// serviço de OUTRO business → 400
		const otherSvc = "00000000-0000-4000-8000-000000000001";
		expect((await post({ ...ok, service_id: otherSvc })).status).toBe(400);

		// body quebrado
		expect(
			(
				await app.request(`/p/${slug}/book`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{quebrado",
				})
			).status,
		).toBe(400);

		// slug inexistente → 404
		expect(
			(
				await app.request("/p/nao-existe-nem-ever/book", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(ok),
				})
			).status,
		).toBe(404);
	});

	it("GET /p/:slug/busy → intervalos ocupados do dia (para filtro de slots)", async () => {
		const uid = `pub-busy-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro Busy" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Busy" }),
		});
		const synced = (await syncRes.json()) as { business?: { slug?: string } };
		const slug = synced.business?.slug as string;
		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "B", duration_min: 30, price_cents: 0 }),
		});
		const svc = (await svcRes.json()) as { id: string };
		const tomorrow = new Date(Date.now() + 86_400_000);
		const ds = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

		// dia sem agendamentos → busy vazio
		const empty = await app.request(`/p/${slug}/busy?date=${ds}`);
		expect(empty.status).toBe(200);
		expect(((await empty.json()) as { busy: unknown[] }).busy).toHaveLength(0);

		// cria um agendamento 09:00–09:30
		const start = new Date(tomorrow);
		start.setHours(9, 0, 0, 0);
		const bookRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Busy Test",
				phone: "14999997000",
				service_id: svc.id,
				starts_at: start.toISOString(),
			}),
		});
		expect(bookRes.status).toBe(201);

		const busyRes = await app.request(`/p/${slug}/busy?date=${ds}`);
		expect(busyRes.status).toBe(200);
		const { busy } = (await busyRes.json()) as {
			busy: { start: string; end: string }[];
		};
		expect(busy).toHaveLength(1);
		expect(new Date(busy[0]!.start).getHours()).toBe(9);
		expect(new Date(busy[0]!.end).getHours()).toBe(9);
		expect(new Date(busy[0]!.end).getMinutes()).toBe(30);

		// validação: date inválida E date ausente (?? "" cai no NaN)
		expect((await app.request(`/p/${slug}/busy?date=xxx`)).status).toBe(400);
		expect((await app.request(`/p/${slug}/busy`)).status).toBe(400);
		// slug inexistente
		expect(
			(await app.request("/p/nao-existe/busy?date=2026-01-01")).status,
		).toBe(404);
	});

	it("GET /p/:slug/ics/:id → convite VCALENDAR do agendamento", async () => {
		const uid = `pub-ics-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro ICS" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro ICS" }),
		});
		const synced = (await syncRes.json()) as { business?: { slug?: string } };
		const slug = synced.business?.slug as string;
		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte ICS",
				duration_min: 30,
				price_cents: 0,
			}),
		});
		const svc = (await svcRes.json()) as { id: string };
		const start = new Date(Date.now() + 86_400_000);
		const bookRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Cliente ICS",
				phone: "14999996000",
				service_id: svc.id,
				starts_at: start.toISOString(),
			}),
		});
		const booking = (await bookRes.json()) as { id: string };

		const res = await app.request(`/p/${slug}/ics/${booking.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/calendar");
		const body = await res.text();
		expect(body).toContain("BEGIN:VCALENDAR");
		expect(body).toContain("BEGIN:VEVENT");
		expect(body).toContain(`UID:${booking.id}`);
		expect(body).toContain("Corte ICS com Pro ICS");
		expect(body).toContain("BEGIN:VALARM");

		// slug inexistente → 404
		expect((await app.request(`/p/nao-existe/ics/${booking.id}`)).status).toBe(
			404,
		);
		// slug inexistente → 404
		expect((await app.request(`/p/nao-existe/ics/${booking.id}`)).status).toBe(
			404,
		);
		// serviço arquivado depois do booking → .ics continua funcionando
		// (o cliente precisa do convite mesmo se o prof. arquivar o serviço)
		await sql`update services set archived_at = now() where id = ${svc.id}`;
		expect((await app.request(`/p/${slug}/ics/${booking.id}`)).status).toBe(
			200,
		);
		// id inválido → 400
		expect((await app.request(`/p/${slug}/ics/nao-uuid`)).status).toBe(400);
		// agendamento de OUTRO business → 404 (não vaza por slug diferente)
		const otherUid = `pub-ics2-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== otherUid) throw new Error("invalid");
			return { uid: otherUid, email: `${otherUid}@t.com`, name: "Pro ICS2" };
		});
		const otherSync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...authed(otherUid) },
			body: JSON.stringify({ name: "Pro ICS2" }),
		});
		const otherBiz = (await otherSync.json()) as {
			business?: { slug?: string };
		};
		expect(
			(await app.request(`/p/${otherBiz.business?.slug}/ics/${booking.id}`))
				.status,
		).toBe(404);
	});

	it("info de slug inexistente → 404", async () => {
		expect((await app.request("/p/nao-existe/info")).status).toBe(404);
	});

	it("trial com trial_ends_at null → book passa (legado)", async () => {
		const uid = `pub-null-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro Null" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Null" }),
		});
		const synced = (await syncRes.json()) as { business?: { slug?: string } };
		const bizSlug = synced.business?.slug;
		expect(bizSlug).toBeTruthy();
		const slug = bizSlug as string;
		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "N", duration_min: 15, price_cents: 0 }),
		});
		const svc = (await svcRes.json()) as { id: string };

		const bizRows = await sql`select id from businesses where slug = ${slug}`;
		await sql`update businesses set subscription_status = 'trial', trial_ends_at = null where id = ${bizRows[0]?.id}`;

		const res = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "X",
				phone: "14999995555",
				service_id: svc.id,
				starts_at: new Date(Date.now() + 86_400_000).toISOString(),
			}),
		});
		expect(res.status).toBe(201);
	});

	it("paywall: trial vencido → book 402, info continua 200", async () => {
		const uid = `pub-pay-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro Pay" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Pay" }),
		});
		const synced = (await syncRes.json()) as { business?: { slug?: string } };
		const bizSlug = synced.business?.slug;
		expect(bizSlug).toBeTruthy();
		const slug = bizSlug as string;

		// cria serviço ANTES de vencer o trial (POST /v1 bloqueia com trial vencido)
		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "PaySvc",
				duration_min: 30,
				price_cents: 0,
			}),
		});
		expect(svcRes.status).toBe(201);

		// vence o trial direto no banco
		const bizRows = await sql`select id from businesses where slug = ${slug}`;
		await sql`update businesses set trial_ends_at = now() - interval '1 day' where id = ${bizRows[0]?.id}`;

		// info (leitura) continua aberta
		expect((await app.request(`/p/${slug}/info`)).status).toBe(200);
		// book bloqueado
		const res = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "X",
				phone: "14999990000",
				service_id: "00000000-0000-4000-8000-000000000002",
				starts_at: new Date(Date.now() + 86_400_000).toISOString(),
			}),
		});
		expect(res.status).toBe(402);

		// reativa com status ACTIVE: agora canWrite passa por "active" → book 201
		await sql`update businesses set subscription_status = 'active', trial_ends_at = now() + interval '30 days' where id = ${bizRows[0]?.id}`;
		const svcRows =
			await sql`select id from services where business_id = ${bizRows[0]?.id} limit 1`;
		const okRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Pós-reativação",
				phone: "14999994444",
				service_id: svcRows[0]?.id,
				starts_at: new Date(Date.now() + 172_800_000).toISOString(),
			}),
		});
		expect(okRes.status).toBe(201);

		// status desconhecido (canceled) → return false → 402
		await sql`update businesses set subscription_status = 'canceled' where id = ${bizRows[0]?.id}`;
		const cxRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Pós-cancel",
				phone: "14999993333",
				service_id: svcRows[0]?.id,
				starts_at: new Date(Date.now() + 259_200_000).toISOString(),
			}),
		});
		expect(cxRes.status).toBe(402);
		// restaura pra cleanup
		await sql`update businesses set subscription_status = 'trial' where id = ${bizRows[0]?.id}`;
	});

	it("rate limit: 11 bookings em 1min do mesmo IP → 429", async () => {
		const uid = `pub-rl-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro RL" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro RL" }),
		});
		const synced = (await syncRes.json()) as { business?: { slug?: string } };
		const bizSlug = synced.business?.slug;
		expect(bizSlug).toBeTruthy();
		const slug = bizSlug as string;
		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "RL", duration_min: 15, price_cents: 0 }),
		});
		const svc = (await svcRes.json()) as { id: string };

		// 10 bookings válidos em horários diferentes (dentro do limite)
		let saw429 = false;
		for (let i = 0; i < 12; i++) {
			const start = new Date(Date.now() + (86_400_000 + i * 3_600_000));
			const res = await app.request(`/p/${slug}/book`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: `RL ${i}`,
					phone: `14999990${String(i).padStart(2, "0")}`,
					service_id: svc.id,
					starts_at: start.toISOString(),
				}),
			});
			if (res.status === 429) {
				saw429 = true;
				break;
			}
			expect(res.status).toBe(201);
		}
		expect(saw429).toBe(true);
	});
});

describe("B1 Task 3: backend continua autoridade (409 com duração do novo serviço)", () => {
	it("09:30+30 apenas encosta na ocupação 10:00 → 201; 09:30+60 sobrepõe → 409", async () => {
		const uid = `pub-rl-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== uid) throw new Error("invalid");
			return { uid, email: `${uid}@t.com`, name: "Pro RL 2" };
		});
		const h = authed(uid);
		const syncRes = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro RL 2" }),
		});
		const slug = ((await syncRes.json()) as { business?: { slug?: string } })
			.business?.slug as string;
		expect(slug).toBeTruthy();

		// dois serviços: curto 30min e longo 60min
		const mk = async (name: string, duration_min: number) => {
			const r = await app.request("/v1/services", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({ name, duration_min, price_cents: 0 }),
			});
			return (await r.json()) as { id: string };
		};
		const short = await mk("Curto B1", 30);
		const long = await mk("Longo B1", 60);

		// horário de amanhã 08:00–18:00
		const day = new Date(Date.now() + 86_400_000);
		await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [
					{
						weekday: day.getDay(),
						start_minute: 8 * 60,
						end_minute: 18 * 60,
					},
				],
			}),
		});

		// ocupação: 10:00–10:30 (outro cliente, serviço curto)
		const occStart = new Date(day);
		occStart.setHours(10, 0, 0, 0);
		const occRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Ocupa 10h",
				phone: "14999101010",
				service_id: short.id,
				starts_at: occStart.toISOString(),
			}),
		});
		expect(occRes.status).toBe(201);

		// 09:30 + 30min termina exatamente 10:00 (encosta) → aceito
		const touching = new Date(day);
		touching.setHours(9, 30, 0, 0);
		const okRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Encosta Ok",
				phone: "14999309300",
				service_id: short.id,
				starts_at: touching.toISOString(),
			}),
		});
		expect(okRes.status).toBe(201);

		// 09:30 + 60min atravessa a ocupação → 409 (autoridade do backend,
		// endsAt recalculado com svc.durationMin)
		const overlapRes = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Sobrepõe 409",
				phone: "14999600900",
				service_id: long.id,
				starts_at: touching.toISOString(),
			}),
		});
		expect(overlapRes.status).toBe(409);
	});
});

describe("B1: paridade TS/HTML e preservação do slot ao trocar serviço", () => {
	it("HTML embute cópia de slotStillValid (paridade de existência)", async () => {
		const res = await app.request("/p/paridade-b1");
		const html = await res.text();
		expect(html).toContain("function slotStillValid(");
	});

	it("paridade: cópia inline e função de domínio concordam nos mesmos vetores", async () => {
		const res = await app.request("/p/paridade-b1");
		const html = await res.text();
		// extrai o corpo da função inline (da assinatura até "return !busy")
		const start = html.indexOf("function slotStillValid(");
		expect(start).toBeGreaterThan(-1);
		const snippet = html.slice(start, html.indexOf("</script>", start));
		// avalia num escouro com Date nativo; stub de window (o snippet segue
		// até </script> e referencia window em código posterior)
		const inline = new Function("window", `${snippet}; return slotStillValid;`)(
			{ PICKED: null },
		) as (...args: unknown[]) => boolean;
		const NOW = new Date("2026-10-23T08:30:00");
		const vectors = [
			{
				picked: new Date("2026-10-23T09:00:00"),
				day: new Date("2026-10-23T00:00:00"),
				durationMin: 45,
				workingHours: [{ weekday: 5, start_time: "08:00", end_time: "18:00" }],
				busy: [{ start: "2026-10-23T10:00:00", end: "2026-10-23T10:30:00" }],
				now: NOW,
			},
			{
				picked: new Date("2026-10-23T09:30:00"),
				day: new Date("2026-10-23T00:00:00"),
				durationMin: 60,
				workingHours: [{ weekday: 5, start_time: "08:00", end_time: "18:00" }],
				busy: [{ start: "2026-10-23T10:00:00", end: "2026-10-23T10:30:00" }],
				now: NOW,
			},
			{
				picked: new Date("2026-10-23T17:30:00"),
				day: new Date("2026-10-23T00:00:00"),
				durationMin: 60,
				workingHours: [{ weekday: 5, start_time: "08:00", end_time: "18:00" }],
				busy: [],
				now: NOW,
			},
			{
				picked: new Date("2026-10-23T09:00:00"),
				day: new Date("2026-10-23T00:00:00"),
				durationMin: 45,
				workingHours: [],
				busy: [],
				now: NOW,
			},
			{
				picked: new Date("2026-10-23T08:00:00"),
				day: new Date("2026-10-23T00:00:00"),
				durationMin: 45,
				workingHours: [{ weekday: 5, start_time: "08:00", end_time: "18:00" }],
				busy: [],
				now: NOW,
			},
		];
		for (const v of vectors) {
			// inline tem assinatura posicional; domínio recebe objeto — mesmos vetores
			expect(
				inline(v.picked, v.day, v.durationMin, v.workingHours, v.busy, v.now),
			).toBe(slotStillValid(v));
		}
	});

	it("HTML: pick() troca serviço e loadSlots avalia validade (preserva window.PICKED)", async () => {
		const res = await app.request("/p/paridade-b1");
		const html = await res.text();
		// pick não pode mais limpar PICKED incondicionalmente; loadSlots decide
		expect(html).toContain("window.pick = id => { SEL=id;");
		expect(html).not.toContain("SEL=id; window.PICKED=null");
		// loadSlots usa slotStillValid (cópia inline) e mostra mensagem RF-02
		expect(html).toContain("slotStillValid(");
		expect(html).toContain(
			"o horário escolhido não está disponível para este serviço — escolha outro",
		);
	});
});

/**
 * Integração REAL (0026): link público do AGREGADOR com seletor de
 * profissional. O agendamento mora no business do profissional e marca o
 * agregador de origem; o link de independente não muda.
 */

import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));
const sendToUserMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/services/fcm.js", () => ({ sendToUser: sendToUserMock }));

import { createApp } from "../../src/app.js";
import { resetRateLimit } from "../../src/routes/public-booking.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const PREFIX = "Pro AggLink";
const tag = `agl-${Date.now() % 1_000_000}`;
let seq = 0;

function as(u: string) {
	verifyMock.mockImplementation(async (t: string) => {
		if (t !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: `${PREFIX} ${u}` };
	});
	return { Authorization: `Bearer ${u}` };
}

type Acc = {
	userId: string;
	businessId: string;
	slug: string;
	name: string;
	serviceId: string;
};

/** Conta com 1 serviço e expediente de 24h todo dia (agenda pronta). */
async function account(opts: { attends?: boolean } = {}): Promise<Acc> {
	const uid = `${tag}-${seq++}`;
	const name = `${PREFIX} ${uid}`;
	const r = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...as(uid) },
		body: JSON.stringify({ name }),
	});
	const j = (await r.json()) as {
		user: { id: string };
		business: { id: string; slug: string };
	};
	let serviceId = "";
	if (opts.attends !== false) {
		const [svc] = await sql<[{ id: string }]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${j.business.id}, ${`Corte ${uid}`}, 30, 5000) RETURNING id`;
		serviceId = svc.id;
		await sql`
      INSERT INTO working_hours (user_id, weekday, start_time, end_time)
      SELECT ${j.user.id}, d, '00:00', '23:59' FROM generate_series(0, 6) d`;
	}
	return {
		userId: j.user.id,
		businessId: j.business.id,
		slug: j.business.slug,
		name,
		serviceId,
	};
}

async function makeAggregator(a: Acc) {
	await sql`
    UPDATE businesses SET account_kind = 'aggregator',
      aggregator_code = gen_agenva_code('E-') WHERE id = ${a.businessId}`;
}

async function link(
	agg: Acc,
	pro: Acc,
	extra: { status?: string; show?: boolean; position?: number } = {},
) {
	const [row] = await sql<[{ id: string }]>`
    INSERT INTO professional_links (aggregator_business_id, professional_user_id,
      status, requested_by, show_on_link, position)
    VALUES (${agg.businessId}, ${pro.userId}, ${extra.status ?? "active"},
      'aggregator', ${extra.show ?? true}, ${extra.position ?? 0})
    RETURNING id`;
	return row.id;
}

const get = (path: string) => app.request(path);
const post = (path: string, body: unknown) =>
	app.request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

type Info = {
	business: { name: string; buffer_min: number };
	professional: { name: string };
	services: { id: string }[];
	working_hours: unknown[];
	professionals?: { id: string; name: string; logo_url: string | null }[];
};

function future(days: number, hourUtc = 14) {
	const d = new Date(Date.now() + days * 86_400_000);
	d.setUTCHours(hourUtc, 0, 0, 0);
	return d.toISOString();
}
const dateOf = (iso: string) => iso.slice(0, 10);

async function notificationsOf(userId: string, type: string) {
	for (let i = 0; i < 50; i++) {
		const rows = await sql<{ body: string; data: Record<string, string> }[]>`
      SELECT body, data FROM notifications WHERE user_id = ${userId} AND type = ${type}`;
		if (rows.length > 0) return rows;
		await new Promise((r) => setTimeout(r, 20));
	}
	return [];
}

let agg: Acc;
let proA: Acc;
let proB: Acc;
let linkA: string;
let linkB: string;

beforeAll(async () => {
	agg = await account({ attends: false });
	await makeAggregator(agg);
	proA = await account();
	proB = await account();
	await sql`UPDATE businesses SET buffer_min = 15 WHERE id = ${proA.businessId}`;
	linkA = await link(agg, proA, { position: 2 });
	linkB = await link(agg, proB, { position: 1 });
});

beforeEach(() => {
	resetRateLimit();
});

afterAll(async () => {
	try {
		const biz = sql`SELECT id FROM businesses WHERE name LIKE ${`${PREFIX} agl-%`}`;
		const usr = sql`SELECT id FROM users WHERE business_id IN (${biz})`;
		await sql`DELETE FROM professional_links WHERE aggregator_business_id IN (${biz}) OR professional_user_id IN (${usr})`;
		await sql`DELETE FROM notifications WHERE business_id IN (${biz})`;
		await sql`DELETE FROM waitlist WHERE business_id IN (${biz})`;
		await sql`DELETE FROM appointments WHERE business_id IN (${biz})`;
		await sql`DELETE FROM services WHERE business_id IN (${biz})`;
		await sql`DELETE FROM clients WHERE business_id IN (${biz})`;
		await sql`DELETE FROM working_hours WHERE user_id IN (${usr})`;
		await sql`DELETE FROM users WHERE business_id IN (${biz})`;
		await sql`DELETE FROM businesses WHERE name LIKE ${`${PREFIX} agl-%`}`;
	} catch {
		// registro apagado por outro worker — ok
	}
	await sql.end();
});

describe("GET /p/:slug/info", () => {
	it("independente: contrato igual ao de antes (sem professionals) e ignora ?professional", async () => {
		const r = await get(`/p/${proA.slug}/info?professional=${linkA}`);
		expect(r.status).toBe(200);
		const j = (await r.json()) as Info;
		expect(j).not.toHaveProperty("professionals");
		expect(j.professional.name).toBe(proA.name);
		expect(j.services.map((s) => s.id)).toEqual([proA.serviceId]);
	});

	it("agregador sem escolha: só o seletor, na ordem definida", async () => {
		const j = (await (await get(`/p/${agg.slug}/info`)).json()) as Info;
		expect(j.business.name).toBe(agg.name);
		expect(j.services).toEqual([]);
		expect(j.working_hours).toEqual([]);
		expect(j.professionals).toEqual([
			{ id: linkB, name: proB.name, logo_url: null },
			{ id: linkA, name: proA.name, logo_url: null },
		]);
	});

	it("com profissional escolhido: catálogo, horários e folga DELE; nome da página é o do agregador", async () => {
		const j = (await (
			await get(`/p/${agg.slug}/info?professional=${linkA}`)
		).json()) as Info;
		expect(j.business.name).toBe(agg.name);
		expect(j.business.buffer_min).toBe(15);
		expect(j.professional.name).toBe(proA.name);
		expect(j.services.map((s) => s.id)).toEqual([proA.serviceId]);
		expect(j.working_hours).toHaveLength(7);
		expect(j.professionals).toHaveLength(2);
	});

	it("fora do seletor: pendente, oculto, encerrado, vencido, id inválido → 404", async () => {
		const extra = await Promise.all([
			account(),
			account(),
			account(),
			account(),
		]);
		const pending = await link(agg, extra[0] as Acc, { status: "pending" });
		const hidden = await link(agg, extra[1] as Acc, { show: false });
		const ended = await link(agg, extra[2] as Acc, { status: "ended" });
		const expired = await link(agg, extra[3] as Acc);
		await sql`
      UPDATE businesses SET subscription_status = 'canceled'
      WHERE id = ${(extra[3] as Acc).businessId}`;

		const j = (await (await get(`/p/${agg.slug}/info`)).json()) as Info;
		expect(j.professionals?.map((p) => p.id)).toEqual([linkB, linkA]);

		for (const id of [
			pending,
			hidden,
			ended,
			expired,
			"nao-e-uuid",
			"00000000-0000-0000-0000-000000000000",
		]) {
			const r = await get(`/p/${agg.slug}/info?professional=${id}`);
			expect(r.status).toBe(404);
			expect(((await r.json()) as { error: string }).error).toBe(
				"Esse profissional não está disponível neste link",
			);
		}
	});

	it("dono do agregador entra no seletor só se atende (D4); logo aparece", async () => {
		// sem serviço/horário: "owner" indisponível
		expect((await get(`/p/${agg.slug}/info?professional=owner`)).status).toBe(
			404,
		);

		const owner = await account();
		await makeAggregator(owner);
		const l = await link(owner, proB);
		await sql`UPDATE businesses SET logo_mime = 'image/png' WHERE id = ${owner.businessId}`;
		const j = (await (await get(`/p/${owner.slug}/info`)).json()) as Info;
		expect(j.professionals?.[0]).toEqual({
			id: "owner",
			name: owner.name,
			logo_url: `/v1/businesses/${owner.slug}/logo`,
		});
		expect(j.professionals?.[1]?.id).toBe(l);

		const mine = (await (
			await get(`/p/${owner.slug}/info?professional=owner`)
		).json()) as Info;
		expect(mine.services.map((s) => s.id)).toEqual([owner.serviceId]);
	});

	it("slug inexistente → 404", async () => {
		expect((await get("/p/nao-existe-xyz/info")).status).toBe(404);
	});
});

describe("GET /p/:slug/busy", () => {
	it("agregador exige o profissional; ocupa só a agenda dele", async () => {
		const day = future(3);
		const r0 = await get(`/p/${agg.slug}/busy?date=${dateOf(day)}`);
		expect(r0.status).toBe(400);
		expect(((await r0.json()) as { error: string }).error).toBe(
			"Escolha o profissional",
		);

		const booked = await post(`/p/${proA.slug}/book`, {
			name: "Cliente Busy",
			phone: "11988887777",
			service_id: proA.serviceId,
			starts_at: day,
		});
		expect(booked.status).toBe(201);

		const a = (await (
			await get(`/p/${agg.slug}/busy?date=${dateOf(day)}&professional=${linkA}`)
		).json()) as { busy: unknown[] };
		expect(a.busy).toHaveLength(1);
		const b = (await (
			await get(`/p/${agg.slug}/busy?date=${dateOf(day)}&professional=${linkB}`)
		).json()) as { busy: unknown[] };
		expect(b.busy).toHaveLength(0);
	});

	it("slug inexistente → 404", async () => {
		expect((await get("/p/nao-existe-xyz/busy?date=2030-01-01")).status).toBe(
			404,
		);
	});
});

describe("POST /p/:slug/book pelo agregador", () => {
	it("grava no business do profissional, marca o agregador e avisa os dois (D3)", async () => {
		const startsAt = future(4);
		const r = await post(`/p/${agg.slug}/book`, {
			name: "Cliente Agg",
			phone: "(11) 97777-6666",
			service_id: proA.serviceId,
			starts_at: startsAt,
			professional_id: linkA,
		});
		expect(r.status).toBe(201);
		const j = (await r.json()) as {
			id: string;
			business: string;
			professional: string;
		};
		expect(j.business).toBe(agg.name);
		expect(j.professional).toBe(proA.name);

		const [appt] = await sql<
			{
				business_id: string;
				user_id: string;
				aggregator_business_id: string;
				buffer_min: number;
				client_business: string;
			}[]
		>`
      SELECT a.business_id, a.user_id, a.aggregator_business_id, a.buffer_min,
             c.business_id AS client_business
      FROM appointments a JOIN clients c ON c.id = a.client_id
      WHERE a.id = ${j.id}`;
		expect(appt).toEqual({
			business_id: proA.businessId,
			user_id: proA.userId,
			aggregator_business_id: agg.businessId,
			buffer_min: 15,
			client_business: proA.businessId,
		});

		const proN = await notificationsOf(proA.userId, "new_booking");
		expect(proN.some((n) => n.body.includes("Cliente Agg"))).toBe(true);
		const aggN = await notificationsOf(agg.userId, "aggregator_booking");
		expect(aggN).toHaveLength(1);
		expect(aggN[0]?.body).toContain(proA.name);
		// sem dados do cliente para o agregador
		expect(aggN[0]?.body).not.toContain("Cliente Agg");
		expect(Object.keys(aggN[0]?.data ?? {})).toEqual(["starts_at"]);

		// agenda do profissional: o agendamento vem marcado "via" o agregador;
		// os do link próprio, sem marca
		const own = await post(`/p/${proA.slug}/book`, {
			name: "Cliente Direto",
			phone: "(11) 97777-5555",
			service_id: proA.serviceId,
			starts_at: future(4, 18),
		});
		expect(own.status).toBe(201);
		const ownId = ((await own.json()) as { id: string }).id;
		const day = dateOf(startsAt);
		const list = await app.request(
			`/v1/appointments?from=${day}T00:00:00Z&to=${day}T23:59:59Z`,
			{ headers: as(proA.name.slice(PREFIX.length + 1)) },
		);
		expect(list.status).toBe(200);
		const rows = (
			(await list.json()) as {
				appointments: { id: string; aggregator_name: string | null }[];
			}
		).appointments;
		expect(rows.find((x) => x.id === j.id)?.aggregator_name).toBe(agg.name);
		expect(rows.find((x) => x.id === ownId)?.aggregator_name).toBeNull();
	});

	it("agenda única: horário ocupado no link próprio não pode ser marcado pelo agregador", async () => {
		const startsAt = future(5);
		const own = await post(`/p/${proB.slug}/book`, {
			name: "Cliente Próprio",
			phone: "11966665555",
			service_id: proB.serviceId,
			starts_at: startsAt,
		});
		expect(own.status).toBe(201);
		const via = await post(`/p/${agg.slug}/book`, {
			name: "Cliente Via",
			phone: "11955554444",
			service_id: proB.serviceId,
			starts_at: startsAt,
			professional_id: linkB,
		});
		expect(via.status).toBe(409);
	});

	it("serviço tem que ser do profissional escolhido", async () => {
		const r = await post(`/p/${agg.slug}/book`, {
			name: "Cliente X",
			phone: "11944443333",
			service_id: proA.serviceId,
			starts_at: future(6),
			professional_id: linkB,
		});
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toBe(
			"serviço indisponível",
		);
	});

	it("sem profissional → 400; profissional fora do seletor → 404", async () => {
		const base = {
			name: "Cliente Y",
			phone: "11933332222",
			service_id: proA.serviceId,
			starts_at: future(6),
		};
		expect((await post(`/p/${agg.slug}/book`, base)).status).toBe(400);
		expect(
			(
				await post(`/p/${agg.slug}/book`, {
					...base,
					professional_id: "00000000-0000-0000-0000-000000000000",
				})
			).status,
		).toBe(404);
		expect(
			(await post(`/p/${agg.slug}/book`, { ...base, professional_id: 42 }))
				.status,
		).toBe(404);
	});

	it("dono do agregador atendendo: grava no próprio business, sem marca de agregador", async () => {
		const owner = await account();
		await makeAggregator(owner);
		const r = await post(`/p/${owner.slug}/book`, {
			name: "Cliente Dono",
			phone: "11922221111",
			service_id: owner.serviceId,
			starts_at: future(7),
			professional_id: "owner",
		});
		expect(r.status).toBe(201);
		const id = ((await r.json()) as { id: string }).id;
		const [appt] = await sql<
			{ business_id: string; aggregator_business_id: string | null }[]
		>`SELECT business_id, aggregator_business_id FROM appointments WHERE id = ${id}`;
		expect(appt).toEqual({
			business_id: owner.businessId,
			aggregator_business_id: null,
		});
	});

	it("agregador com conta vencida não aceita agendamento (D5)", async () => {
		const late = await account({ attends: false });
		await makeAggregator(late);
		const l = await link(late, proA);
		await sql`UPDATE businesses SET subscription_status = 'canceled' WHERE id = ${late.businessId}`;
		const r = await post(`/p/${late.slug}/book`, {
			name: "Cliente Z",
			phone: "11911110000",
			service_id: proA.serviceId,
			starts_at: future(8),
			professional_id: l,
		});
		expect(r.status).toBe(402);
	});

	it("slug inexistente → 404", async () => {
		expect((await post("/p/nao-existe-xyz/book", {})).status).toBe(404);
	});
});

describe("convite .ics e lista de espera pelo agregador", () => {
	it(".ics pelo slug do agregador traz o profissional do agendamento", async () => {
		const r = await post(`/p/${agg.slug}/book`, {
			name: "Cliente Ics",
			phone: "11900009999",
			service_id: proB.serviceId,
			starts_at: future(9),
			professional_id: linkB,
		});
		const id = ((await r.json()) as { id: string }).id;
		const ics = await get(`/p/${agg.slug}/ics/${id}`);
		expect(ics.status).toBe(200);
		const text = await ics.text();
		expect(text).toContain(
			`DESCRIPTION:Agendamento com ${proB.name} — ${agg.name}`,
		);

		// agendamento de outro business, sem ligação com este link → 404
		const other = await post(`/p/${proA.slug}/book`, {
			name: "Cliente Fora",
			phone: "11900008888",
			service_id: proA.serviceId,
			starts_at: future(10),
		});
		const otherId = ((await other.json()) as { id: string }).id;
		expect((await get(`/p/${agg.slug}/ics/${otherId}`)).status).toBe(404);
	});

	it("lista de espera vai para o business do profissional escolhido", async () => {
		const day = dateOf(future(11));
		const none = await post(`/v1/p/${agg.slug}/waitlist`, {
			name: "Cliente Espera",
			phone: "11900007777",
			desired_date: day,
		});
		expect(none.status).toBe(400);

		const ok = await post(`/v1/p/${agg.slug}/waitlist`, {
			name: "Cliente Espera",
			phone: "11900007777",
			desired_date: day,
			professional_id: linkA,
		});
		expect(ok.status).toBe(201);
		const id = ((await ok.json()) as { id: string }).id;
		const [row] = await sql<{ business_id: string }[]>`
      SELECT business_id FROM waitlist WHERE id = ${id}`;
		expect(row?.business_id).toBe(proA.businessId);
	});
});

describe("nome genérico 'Profissional' (achado do E2E de 06/11)", () => {
	it("seletor, agendamento, aviso e .ics juntam o nome do negócio", async () => {
		const studio = await account();
		await makeAggregator(studio);
		const pro = await account();
		const l = await link(studio, pro);
		// contas criadas pelo app nascem com o nome "Profissional"
		await sql`UPDATE users SET name = 'Profissional' WHERE id IN (${studio.userId}, ${pro.userId})`;

		const info = (await (await get(`/p/${studio.slug}/info`)).json()) as Info;
		expect(info.professionals?.map((p) => p.name)).toEqual([
			`Profissional (${studio.name})`,
			`Profissional (${pro.name})`,
		]);
		const chosen = (await (
			await get(`/p/${studio.slug}/info?professional=${l}`)
		).json()) as Info;
		expect(chosen.professional.name).toBe(`Profissional (${pro.name})`);

		const r = await post(`/p/${studio.slug}/book`, {
			name: "Cliente Genérico",
			phone: "11955554444",
			service_id: pro.serviceId,
			starts_at: future(11),
			professional_id: l,
		});
		expect(r.status).toBe(201);
		const j = (await r.json()) as { id: string; professional: string };
		expect(j.professional).toBe(`Profissional (${pro.name})`);
		const aggN = await notificationsOf(studio.userId, "aggregator_booking");
		expect(aggN[0]?.body.startsWith(`Profissional (${pro.name}) — `)).toBe(
			true,
		);
		const ics = await (await get(`/p/${studio.slug}/ics/${j.id}`)).text();
		expect(ics).toContain(`Agendamento com Profissional (${pro.name})`);
		// pelo link próprio do profissional, o .ics fica como sempre foi
		const own = await post(`/p/${pro.slug}/book`, {
			name: "Cliente Próprio",
			phone: "11955553333",
			service_id: pro.serviceId,
			starts_at: future(11, 18),
		});
		const ownId = ((await own.json()) as { id: string }).id;
		const ownIcs = await (await get(`/p/${pro.slug}/ics/${ownId}`)).text();
		expect(ownIcs).toContain("Agendamento com Profissional —");
	});
});

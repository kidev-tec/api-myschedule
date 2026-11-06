/**
 * Integração REAL (0026): vínculos agregador ↔ profissional.
 * Pedido (E-), convite (P-), aprovar/recusar/cancelar/encerrar, PATCH do
 * seletor, notificações e exclusão de conta com vínculo.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({
		verifyIdToken: verifyMock,
		deleteUser: vi.fn(async () => undefined),
	}),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));
const sendToUserMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/services/fcm.js", () => ({ sendToUser: sendToUserMock }));

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
const tag = `plink-${Date.now() % 1_000_000}`;
// limpeza: afterAll apaga tudo com este prefixo (inclusive sobras de execuções anteriores)
const ALL = "Pro Link plink-%";

function as(u: string) {
	verifyMock.mockImplementation(async (t: string) => {
		if (t !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: `Pro Link ${u}` };
	});
	return { Authorization: `Bearer ${u}` };
}

type Account = {
	uid: string;
	userId: string;
	businessId: string;
	name: string;
	code: string; // P- (independente) ou E- (agregador)
};

async function account(kind: "independent" | "aggregator"): Promise<Account> {
	const uid = `${tag}-${seq++}`;
	const name = `Pro Link ${uid}`;
	const r = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...as(uid) },
		body: JSON.stringify({ name }),
	});
	const j = (await r.json()) as {
		user: { id: string };
		business: { id: string };
	};
	let code: string;
	if (kind === "aggregator") {
		const k = await app.request("/v1/me/account-kind", {
			method: "PUT",
			headers: { "content-type": "application/json", ...as(uid) },
			body: JSON.stringify({ account_kind: "aggregator" }),
		});
		code = ((await k.json()) as { aggregator_code: string }).aggregator_code;
	} else {
		const m = await app.request("/v1/me", { headers: as(uid) });
		code = ((await m.json()) as { pro_code: string }).pro_code;
	}
	return {
		uid,
		userId: j.user.id,
		businessId: j.business.id,
		name,
		code,
	};
}

function call(a: Account, method: string, path: string, body?: unknown) {
	return app.request(`/v1${path}`, {
		method,
		headers: { "content-type": "application/json", ...as(a.uid) },
		body:
			body === undefined
				? undefined
				: typeof body === "string"
					? body
					: JSON.stringify(body),
	});
}

async function json<T>(r: Response) {
	return (await r.json()) as T;
}

type LinkView = {
	id: string;
	status: string;
	requested_by: string;
	awaiting_me: boolean;
	show_on_link: boolean;
	position: number;
	responded_at: string | null;
	counterpart: Record<string, unknown>;
};
async function list(a: Account, as: string) {
	return json<{ links: LinkView[] }>(await call(a, "GET", `/links?as=${as}`));
}

/** notify() roda fora da resposta: espera a linha aparecer no sino. */
async function notificationsOf(userId: string, type: string, min = 1) {
	for (let i = 0; i < 50; i++) {
		const rows = await sql<{ title: string; body: string; data: unknown }[]>`
      SELECT title, body, data FROM notifications
      WHERE user_id = ${userId} AND type = ${type} ORDER BY created_at`;
		if (rows.length >= min) return rows;
		await new Promise((r) => setTimeout(r, 20));
	}
	return [];
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	try {
		const biz = sql`SELECT id FROM businesses WHERE name LIKE ${ALL}`;
		await sql`DELETE FROM professional_links WHERE aggregator_business_id IN (${biz})`;
		await sql`DELETE FROM notifications WHERE business_id IN (${biz})`;
		await sql`DELETE FROM appointments WHERE business_id IN (${biz})`;
		await sql`DELETE FROM services WHERE business_id IN (${biz})`;
		await sql`DELETE FROM clients WHERE business_id IN (${biz})`;
		await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE business_id IN (${biz}))`;
		await sql`DELETE FROM device_tokens WHERE user_id IN (SELECT id FROM users WHERE business_id IN (${biz}))`;
		await sql`DELETE FROM users WHERE business_id IN (${biz})`;
		await sql`DELETE FROM businesses WHERE name LIKE ${ALL}`;
	} catch {
		// registro apagado por outro worker — ok
	}
	await sql.end();
});

describe("profissional pede entrada com o código do estabelecimento (E-)", () => {
	it("cria pendente, avisa o agregador e o agregador aprova", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");

		const r = await call(pro, "POST", "/links", {
			code: agg.code.toLowerCase().replace("-", " "),
		});
		expect(r.status).toBe(201);
		const created = await json<{ id: string; requested_by: string }>(r);
		expect(created.requested_by).toBe("professional");

		const req = await notificationsOf(agg.userId, "link_request");
		expect(req[0]?.body).toContain(pro.name);
		expect(req[0]?.data).toEqual({ link_id: created.id });

		// logo do outro lado aparece quando cadastrada
		await sql`UPDATE businesses SET logo_mime = 'image/png' WHERE id = ${pro.businessId}`;
		const withLogo = (await list(agg, "aggregator")).links[0];
		expect(withLogo?.counterpart.logo_url).toMatch(
			/^\/v1\/businesses\/.+\/logo$/,
		);
		await sql`UPDATE businesses SET logo_mime = NULL WHERE id = ${pro.businessId}`;

		// visão do profissional: esperando o outro lado
		const proView = (await list(pro, "professional")).links;
		expect(proView).toHaveLength(1);
		expect(proView[0]).toMatchObject({
			status: "pending",
			awaiting_me: false,
			counterpart: { name: agg.name, logo_url: null },
		});
		// visão do agregador: cabe a ele responder
		const aggView = (await list(agg, "aggregator")).links;
		expect(aggView[0]).toMatchObject({
			id: created.id,
			awaiting_me: true,
			counterpart: { name: pro.name, pro_code: pro.code },
		});

		// quem pediu não aprova o próprio pedido
		const self = await call(pro, "POST", `/links/${created.id}/accept`);
		expect(self.status).toBe(403);

		const ok = await call(agg, "POST", `/links/${created.id}/accept`);
		expect(ok.status).toBe(200);
		expect(await json(ok)).toEqual({ id: created.id, status: "active" });
		const acc = await notificationsOf(pro.userId, "link_accepted");
		expect(acc[0]?.body).toBe(`${agg.name} aprovou o vínculo.`);

		const after = (await list(pro, "professional")).links[0];
		expect(after?.status).toBe("active");
		expect(after?.responded_at).not.toBeNull();

		// responder de novo → já respondido
		const again = await call(agg, "POST", `/links/${created.id}/reject`);
		expect(again.status).toBe(409);
	});

	it("pedido duplicado enquanto vivo → 409; depois de recusado pode pedir de novo", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const first = await json<{ id: string }>(
			await call(pro, "POST", "/links", { code: agg.code }),
		);
		const dup = await call(pro, "POST", "/links", { code: agg.code });
		expect(dup.status).toBe(409);

		const rej = await call(agg, "POST", `/links/${first.id}/reject`);
		expect(rej.status).toBe(200);
		expect(await json(rej)).toEqual({ id: first.id, status: "rejected" });
		const n = await notificationsOf(pro.userId, "link_rejected");
		expect(n[0]?.body).toBe(`${agg.name} recusou o pedido de vínculo.`);
		// recusado some da lista (só vivos)
		expect((await list(pro, "professional")).links).toHaveLength(0);

		const retry = await call(pro, "POST", "/links", { code: agg.code });
		expect(retry.status).toBe(201);
	});

	it("código inválido, inexistente ou de conta que não é agregadora", async () => {
		const pro = await account("independent");
		for (const body of [{ code: "xyz" }, {}, "{quebrado"]) {
			const r = await call(pro, "POST", "/links", body);
			expect(r.status).toBe(400);
			expect((await json<{ error: string }>(r)).error).toBe(
				"Código inválido. Confira e digite de novo.",
			);
		}
		const none = await call(pro, "POST", "/links", { code: "E-ZZZZZZZZ" });
		expect(none.status).toBe(404);

		// agregador que voltou a independente: código E- deixa de valer
		const ex = await account("aggregator");
		await call(ex, "PUT", "/me/account-kind", { account_kind: "independent" });
		const r = await call(pro, "POST", "/links", { code: ex.code });
		expect(r.status).toBe(404);
	});

	it("conta de estabelecimento não pede entrada em outro estabelecimento", async () => {
		const a = await account("aggregator");
		const b = await account("aggregator");
		const r = await call(a, "POST", "/links", { code: b.code });
		expect(r.status).toBe(400);
		// nem no próprio
		expect((await call(a, "POST", "/links", { code: a.code })).status).toBe(
			400,
		);
	});
});

describe("estabelecimento convida com o código do profissional (P-)", () => {
	it("convite pendente → profissional aceita; avisos dos dois lados", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const r = await call(agg, "POST", "/links", { code: pro.code });
		expect(r.status).toBe(201);
		const link = await json<{ id: string; requested_by: string }>(r);
		expect(link.requested_by).toBe("aggregator");

		const n = await notificationsOf(pro.userId, "link_request");
		expect(n[0]?.body).toContain(`${agg.name} convidou você`);

		const proView = (await list(pro, "professional")).links[0];
		expect(proView?.awaiting_me).toBe(true);
		// o agregador não aceita o próprio convite
		expect((await call(agg, "POST", `/links/${link.id}/accept`)).status).toBe(
			403,
		);

		const ok = await call(pro, "POST", `/links/${link.id}/accept`);
		expect(ok.status).toBe(200);
		const acc = await notificationsOf(agg.userId, "link_accepted");
		expect(acc[0]?.body).toBe(`${pro.name} aprovou o vínculo.`);
	});

	it("só agregador convida; código próprio, inexistente e de outro agregador são recusados", async () => {
		const ind = await account("independent");
		const other = await account("independent");
		const r = await call(ind, "POST", "/links", { code: other.code });
		expect(r.status).toBe(403);

		const agg = await account("aggregator");
		const own = await sql<{ pro_code: string }[]>`
      SELECT pro_code FROM users WHERE id = ${agg.userId}`;
		const self = await call(agg, "POST", "/links", {
			code: own[0]?.pro_code,
		});
		expect(self.status).toBe(400);
		expect((await json<{ error: string }>(self)).error).toBe(
			"Esse é o seu próprio código.",
		);

		expect(
			(await call(agg, "POST", "/links", { code: "P-ZZZZZZZZ" })).status,
		).toBe(404);

		const agg2 = await account("aggregator");
		const agg2Pro = await sql<{ pro_code: string }[]>`
      SELECT pro_code FROM users WHERE id = ${agg2.userId}`;
		const r2 = await call(agg, "POST", "/links", {
			code: agg2Pro[0]?.pro_code,
		});
		expect(r2.status).toBe(400);
		expect((await json<{ error: string }>(r2)).error).toBe(
			"Esse profissional usa uma conta de estabelecimento.",
		);
	});

	it("profissional pode estar em vários estabelecimentos", async () => {
		const pro = await account("independent");
		const a1 = await account("aggregator");
		const a2 = await account("aggregator");
		for (const agg of [a1, a2]) {
			const l = await json<{ id: string }>(
				await call(agg, "POST", "/links", { code: pro.code }),
			);
			await call(pro, "POST", `/links/${l.id}/accept`);
		}
		const mine = (await list(pro, "professional")).links;
		expect(mine.map((l) => l.status)).toEqual(["active", "active"]);
	});
});

describe("cancelar, encerrar e organizar", () => {
	it("cancelar: só quem pediu e só enquanto pendente", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const l = await json<{ id: string }>(
			await call(pro, "POST", "/links", { code: agg.code }),
		);
		// o convidado não cancela (ele recusa)
		expect((await call(agg, "POST", `/links/${l.id}/cancel`)).status).toBe(403);
		const ok = await call(pro, "POST", `/links/${l.id}/cancel`);
		expect(await json(ok)).toEqual({ id: l.id, status: "canceled" });
		expect((await call(pro, "POST", `/links/${l.id}/cancel`)).status).toBe(409);
	});

	it("agregador encerra: profissional é avisado com a contagem de agendamentos futuros (D2)", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const l = await json<{ id: string }>(
			await call(agg, "POST", "/links", { code: pro.code }),
		);
		// encerrar pendente não pode
		expect((await call(agg, "POST", `/links/${l.id}/end`)).status).toBe(409);
		await call(pro, "POST", `/links/${l.id}/accept`);

		// 2 agendamentos futuros do profissional que vieram por este agregador
		const [svc] = await sql<[{ id: string }]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${pro.businessId}, 'Corte', 30, 0) RETURNING id`;
		const [cli] = await sql<[{ id: string }]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${pro.businessId}, 'Cliente', '+5511999990000') RETURNING id`;
		for (const h of [48, 72]) {
			await sql`
        INSERT INTO appointments (business_id, client_id, service_id, user_id,
          starts_at, ends_at, status, source, aggregator_business_id)
        VALUES (${pro.businessId}, ${cli.id}, ${svc.id}, ${pro.userId},
          now() + ${`${h} hours`}::interval, now() + ${`${h} hours 30 minutes`}::interval,
          'pending', 'public_link', ${agg.businessId})`;
		}

		const r = await call(agg, "POST", `/links/${l.id}/end`);
		expect(r.status).toBe(200);
		expect(await json(r)).toEqual({
			id: l.id,
			status: "ended",
			future_appointments: 2,
		});
		const n = await notificationsOf(pro.userId, "link_ended");
		expect(n[0]?.body).toBe(
			`${agg.name} encerrou o vínculo com você. 2 agendamentos futuros que vieram por ${agg.name} continuam na sua agenda.`,
		);
		// os agendamentos continuam
		const left = await sql`
      SELECT 1 FROM appointments WHERE user_id = ${pro.userId} AND status = 'pending'`;
		expect(left).toHaveLength(2);
	});

	it("agregador encerra com 1 e com 0 agendamentos futuros", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const mk = async () => {
			const l = await json<{ id: string }>(
				await call(agg, "POST", "/links", { code: pro.code }),
			);
			await call(pro, "POST", `/links/${l.id}/accept`);
			return l.id;
		};
		const first = await mk();
		await call(agg, "POST", `/links/${first}/end`);
		const n0 = await notificationsOf(pro.userId, "link_ended");
		expect(n0[0]?.body).toBe(`${agg.name} encerrou o vínculo com você.`);

		const [svc] = await sql<[{ id: string }]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${pro.businessId}, 'Barba', 30, 0) RETURNING id`;
		const [cli] = await sql<[{ id: string }]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${pro.businessId}, 'Cliente 2', '+5511999990001') RETURNING id`;
		await sql`
      INSERT INTO appointments (business_id, client_id, service_id, user_id,
        starts_at, ends_at, status, source, aggregator_business_id)
      VALUES (${pro.businessId}, ${cli.id}, ${svc.id}, ${pro.userId},
        now() + interval '5 days', now() + interval '5 days 30 minutes',
        'confirmed', 'public_link', ${agg.businessId})`;
		const second = await mk();
		await call(agg, "POST", `/links/${second}/end`);
		const n1 = await notificationsOf(pro.userId, "link_ended", 2);
		expect(n1[1]?.body).toBe(
			`${agg.name} encerrou o vínculo com você. 1 agendamento futuro que veio por ${agg.name} continua na sua agenda.`,
		);
	});

	it("aceitar e cancelar ao mesmo tempo: só um vence, o outro recebe 409", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		for (let i = 0; i < 5; i++) {
			const l = await json<{ id: string }>(
				await call(pro, "POST", "/links", { code: agg.code }),
			);
			const [acc, can] = await Promise.all([
				call(agg, "POST", `/links/${l.id}/accept`),
				call(pro, "POST", `/links/${l.id}/cancel`),
			]);
			expect([acc.status, can.status].sort()).toEqual([200, 409]);
			const [row] = await sql<{ status: string }[]>`
        SELECT status FROM professional_links WHERE id = ${l.id}`;
			expect(row?.status).toBe(acc.status === 200 ? "active" : "canceled");
			if (row?.status === "active") {
				await call(pro, "POST", `/links/${l.id}/end`);
			}
		}
	});

	it("profissional sai: agregador é avisado", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const l = await json<{ id: string }>(
			await call(pro, "POST", "/links", { code: agg.code }),
		);
		await call(agg, "POST", `/links/${l.id}/accept`);
		const r = await call(pro, "POST", `/links/${l.id}/end`);
		expect(
			(await json<{ future_appointments: number }>(r)).future_appointments,
		).toBe(0);
		const n = await notificationsOf(agg.userId, "link_ended");
		expect(n[0]?.body).toBe(`${pro.name} saiu de ${agg.name}.`);
	});

	it("nome genérico 'Profissional': avisos ao estabelecimento trazem o negócio do profissional", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		// contas criadas pelo app nascem com o nome "Profissional"
		await sql`UPDATE users SET name = 'Profissional' WHERE id = ${pro.userId}`;
		const who = `Profissional (${pro.name})`;

		// pedido do profissional
		const l = await json<{ id: string }>(
			await call(pro, "POST", "/links", { code: agg.code }),
		);
		const req = await notificationsOf(agg.userId, "link_request");
		expect(req[0]?.body).toBe(
			`${who} quer fazer parte de ${agg.name}. Toque para responder.`,
		);
		await call(agg, "POST", `/links/${l.id}/accept`);
		await call(pro, "POST", `/links/${l.id}/end`);
		const ended = await notificationsOf(agg.userId, "link_ended");
		expect(ended[0]?.body).toBe(`${who} saiu de ${agg.name}.`);

		// convite do estabelecimento: aceite e recusa avisam com o negócio
		const inv = await json<{ id: string }>(
			await call(agg, "POST", "/links", { code: pro.code }),
		);
		await call(pro, "POST", `/links/${inv.id}/reject`);
		const rej = await notificationsOf(agg.userId, "link_rejected");
		expect(rej[0]?.body).toBe(`${who} recusou o pedido de vínculo.`);
		const inv2 = await json<{ id: string }>(
			await call(agg, "POST", "/links", { code: pro.code }),
		);
		await call(pro, "POST", `/links/${inv2.id}/accept`);
		const acc = await notificationsOf(agg.userId, "link_accepted");
		expect(acc[0]?.body).toBe(`${who} aprovou o vínculo.`);
	});

	it("PATCH: agregador controla seletor e ordem; validações", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const l = await json<{ id: string }>(
			await call(agg, "POST", "/links", { code: pro.code }),
		);
		const ok = await call(agg, "PATCH", `/links/${l.id}`, {
			show_on_link: false,
			position: 3,
		});
		expect(await json(ok)).toEqual({
			id: l.id,
			show_on_link: false,
			position: 3,
		});
		const view = (await list(agg, "aggregator")).links[0];
		expect(view).toMatchObject({ show_on_link: false, position: 3 });

		expect(
			(await call(pro, "PATCH", `/links/${l.id}`, { position: 1 })).status,
		).toBe(403);
		for (const body of [
			{ show_on_link: "sim" },
			{ position: -1 },
			{ position: 1.5 },
			{ position: "2" },
			{ position: 1000 },
			{},
			"{quebrado",
		]) {
			expect((await call(agg, "PATCH", `/links/${l.id}`, body)).status).toBe(
				400,
			);
		}
	});

	it("quem não é parte do vínculo, id inválido ou inexistente → 404", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const stranger = await account("independent");
		const l = await json<{ id: string }>(
			await call(pro, "POST", "/links", { code: agg.code }),
		);
		for (const path of [
			`/links/${l.id}/accept`,
			`/links/${l.id}/cancel`,
			`/links/${l.id}/end`,
			"/links/nao-e-uuid/reject",
			"/links/00000000-0000-0000-0000-000000000000/accept",
		]) {
			expect((await call(stranger, "POST", path)).status).toBe(404);
		}
		expect(
			(await call(stranger, "PATCH", `/links/${l.id}`, { position: 1 })).status,
		).toBe(404);
	});

	it("GET /links exige as=aggregator|professional; usuário não sincronizado → 404", async () => {
		const pro = await account("independent");
		expect((await call(pro, "GET", "/links")).status).toBe(400);
		const ghost = await app.request("/v1/links?as=professional", {
			headers: as(`${tag}-ghost`),
		});
		expect(ghost.status).toBe(404);
	});
});

describe("efeitos em outras rotas", () => {
	it("agregador não volta a independente com vínculo vivo criado pela API", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		await call(agg, "POST", "/links", { code: pro.code });
		const r = await call(agg, "PUT", "/me/account-kind", {
			account_kind: "independent",
		});
		expect(r.status).toBe(409);
	});

	it("excluir a conta do profissional ou do agregador não quebra com vínculo", async () => {
		const agg = await account("aggregator");
		const pro = await account("independent");
		const l = await json<{ id: string }>(
			await call(pro, "POST", "/links", { code: agg.code }),
		);
		await call(agg, "POST", `/links/${l.id}/accept`);
		await notificationsOf(pro.userId, "link_accepted");

		const del = await call(pro, "DELETE", "/auth/account");
		expect(del.status).toBe(200);
		const gone = await sql`SELECT 1 FROM professional_links WHERE id = ${l.id}`;
		expect(gone).toHaveLength(0);

		const pro2 = await account("independent");
		const l2 = await json<{ id: string }>(
			await call(agg, "POST", "/links", { code: pro2.code }),
		);
		await notificationsOf(pro2.userId, "link_request");
		const delAgg = await call(agg, "DELETE", "/auth/account");
		expect(delAgg.status).toBe(200);
		const gone2 =
			await sql`SELECT 1 FROM professional_links WHERE id = ${l2.id}`;
		expect(gone2).toHaveLength(0);
	});

	it("POST /appointments aceita profissional do mesmo negócio (outro negócio: appointments-gaps)", async () => {
		const owner = await account("independent");
		// 2º profissional no MESMO business (role pro)
		const [colleague] = await sql<[{ id: string }]>`
      INSERT INTO users (business_id, firebase_uid, email, name, role)
      VALUES (${owner.businessId}, ${`${tag}-colega-${seq++}`}, 'colega@t.com', 'Colega', 'pro')
      RETURNING id`;
		const [svc] = await sql<[{ id: string }]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${owner.businessId}, 'Corte', 30, 0) RETURNING id`;
		const [cli] = await sql<[{ id: string }]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${owner.businessId}, 'Cliente', '+5511999990002') RETURNING id`;
		await sql`
      INSERT INTO working_hours (user_id, weekday, start_time, end_time)
      SELECT ${colleague.id}, d, '00:00', '23:59' FROM generate_series(0, 6) d`;
		const start = new Date(Date.now() + 10 * 86_400_000);
		start.setUTCHours(13, 0, 0, 0);
		const r = await call(owner, "POST", "/appointments", {
			clientId: cli.id,
			serviceId: svc.id,
			userId: colleague.id,
			startsAt: start.toISOString(),
			endsAt: new Date(start.getTime() + 1_800_000).toISOString(),
		});
		expect(r.status).toBe(201);
		const saved = await sql<{ user_id: string }[]>`
      SELECT user_id FROM appointments
      WHERE business_id = ${owner.businessId} AND starts_at = ${start}`;
		expect(saved[0]?.user_id).toBe(colleague.id);
	});
});

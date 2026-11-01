/**
 * Lista de espera v2: celular com máscara/sem 55 reaproveita o cadastro,
 * dia passado recusado, mensagens humanas, prestador adiciona (cliente
 * cadastrado ou nome+celular) e remove, ordem de chegada, aviso de vaga no
 * dia do fuso do negócio, rate limit e botão no link público.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));
const sendToUserMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/services/fcm.js", () => ({ sendToUser: sendToUserMock }));

import { createApp } from "../../src/app.js";
import { dayKey } from "../../src/domain/schedule-day.js";
import { resetRateLimit } from "../../src/routes/public-booking.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

const TZ = "America/Sao_Paulo";
const u = `wl2-uid-${Date.now() % 100_000}`;
const h = { Authorization: `Bearer ${u}` };
let bizId = "";
let slug = "";
let userId = "";

const day = (n: number) => dayKey(new Date(Date.now() + n * 86_400_000), TZ);
const pub = (body: unknown) =>
	app.request(`/v1/p/${slug}/waitlist`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const req = (method: string, path: string, body?: unknown) =>
	app.request(path, {
		method,
		headers: { "content-type": "application/json", ...h },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
type Entry = {
	id: string;
	client_id: string;
	client_name: string;
	phone: string;
	status: string;
	created_at: string;
};
const list = async (d: string) =>
	(
		(await (await req("GET", `/v1/waitlist?date=${d}`)).json()) as {
			waitlist: Entry[];
		}
	).waitlist;

beforeAll(async () => {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro WL2" };
	});
	const sync = await req("POST", "/v1/auth/sync", { name: `Pro WL2 ${u}` });
	const b = ((await sync.json()) as { business: { id: string; slug: string } })
		.business;
	bizId = b.id;
	slug = b.slug;
	userId =
		(
			await sql<
				{ id: string }[]
			>`SELECT id FROM users WHERE firebase_uid = ${u}`
		)[0]?.id ?? "";
	resetRateLimit();
});

afterAll(async () => {
	await sql`DELETE FROM waitlist WHERE business_id = ${bizId}`;
	await sql`DELETE FROM notifications WHERE business_id = ${bizId}`;
	await sql`DELETE FROM appointments WHERE business_id = ${bizId}`;
	await sql`DELETE FROM services WHERE business_id = ${bizId}`;
	await sql`DELETE FROM clients WHERE business_id = ${bizId}`;
	await sql`DELETE FROM users WHERE id = ${userId}`;
	await sql`DELETE FROM businesses WHERE id = ${bizId}`;
	await sql.end();
});

describe("POST público /p/:slug/waitlist", () => {
	it("celular com máscara reaproveita o cliente e não duplica", async () => {
		const [ana] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${bizId}, 'Ana Cadastro', '5511987650001') RETURNING id`;
		const d = day(3);
		const res = await pub({
			name: "Ana do Link",
			phone: "(11) 98765-0001",
			desired_date: d,
		});
		expect(res.status).toBe(201);
		expect(((await res.json()) as { desired_date: string }).desired_date).toBe(
			d,
		);
		const rows = await list(d);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.client_id).toBe(ana?.id);
		expect(rows[0]?.client_name).toBe("Ana Cadastro");
		expect(rows[0]?.phone).toBe("5511987650001");
		expect(rows[0]?.status).toBe("waiting");

		// mesmo celular sem 55 → "já está na lista"
		const dup = await pub({
			client_name: "Ana",
			phone: "11987650001",
			desired_date: d,
		});
		expect(dup.status).toBe(409);
		expect(((await dup.json()) as { error: string }).error).toBe(
			`Você já está na lista de espera de ${d.slice(8, 10)}/${d.slice(5, 7)}`,
		);
	});

	it("cliente novo pelo link: cadastro com origem do link", async () => {
		const res = await pub({
			name: "Novo Link",
			phone: "+55 (11) 98765-0002",
			desired_date: day(0),
		});
		expect(res.status).toBe(201);
		const [c] = await sql<{ phone_e164: string; origin: string }[]>`
      SELECT phone_e164, origin FROM clients
      WHERE business_id = ${bizId} AND name = 'Novo Link'`;
		expect(c).toEqual({ phone_e164: "5511987650002", origin: "public_link" });
	});

	it("validações com mensagens humanas", async () => {
		const cases: [unknown, string][] = [
			[
				{ name: "", phone: "11987650003", desired_date: day(1) },
				"Informe o nome",
			],
			[
				{ name: "X", phone: "1198", desired_date: day(1) },
				"Informe um WhatsApp válido, com DDD",
			],
			[{ name: "X", phone: "11987650003" }, "Escolha o dia da lista de espera"],
			[
				{ name: "X", phone: "11987650003", desired_date: "25/12" },
				"Escolha o dia da lista de espera",
			],
			[
				{ name: "X", phone: "11987650003", desired_date: "2026-02-31x" },
				"Escolha o dia da lista de espera",
			],
			[
				{ name: "X", phone: "11987650003", desired_date: day(-1) },
				"Esse dia já passou — escolha hoje ou um dia futuro",
			],
		];
		for (const [body, msg] of cases) {
			const res = await pub(body);
			expect(res.status, msg).toBe(400);
			expect(((await res.json()) as { error: string }).error).toBe(msg);
		}
		const nf = await app.request("/v1/p/nao-existe-wl2/waitlist", {
			method: "POST",
			body: "{}",
		});
		expect(nf.status).toBe(404);
	});

	it("rate limit: 11ª tentativa no minuto → 429", async () => {
		resetRateLimit();
		let last = 0;
		for (let i = 0; i < 11; i++) {
			last = (await pub({ name: "", phone: "", desired_date: "" })).status;
		}
		expect(last).toBe(429);
		resetRateLimit();
	});
});

describe("prestador: adicionar, listar, remover", () => {
	it("adiciona por client_id e por nome+celular; ordem de chegada", async () => {
		const d = day(5);
		const [bia] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${bizId}, 'Bia', '5511987650010') RETURNING id`;
		const a = await req("POST", "/v1/waitlist", {
			client_id: bia?.id,
			desired_date: d,
		});
		expect(a.status).toBe(201);
		expect(((await a.json()) as { client_name: string }).client_name).toBe(
			"Bia",
		);
		// nome+celular de quem já é cliente (sem 55) → usa o cadastro
		const b = await req("POST", "/v1/waitlist", {
			name: "Caio Novo",
			phone: "(11) 98765-0011",
			desired_date: d,
		});
		expect(b.status).toBe(201);
		const rows = await list(d);
		expect(rows.map((r) => r.client_name)).toEqual(["Bia", "Caio Novo"]);
		expect(Date.parse(rows[0]?.created_at ?? "")).toBeGreaterThan(0);
		const [caio] = await sql<{ origin: string }[]>`
      SELECT origin FROM clients WHERE business_id = ${bizId} AND name = 'Caio Novo'`;
		expect(caio?.origin).toBe("app");

		// de novo → 409 com o nome
		const dup = await req("POST", "/v1/waitlist", {
			client_id: bia?.id,
			desired_date: d,
		});
		expect(dup.status).toBe(409);
		expect(((await dup.json()) as { error: string }).error).toBe(
			`Bia já está na lista de espera de ${d.slice(8, 10)}/${d.slice(5, 7)}`,
		);

		// remover
		const id = rows[0]?.id ?? "";
		expect((await req("DELETE", `/v1/waitlist/${id}`)).status).toBe(200);
		expect((await list(d)).map((r) => r.client_name)).toEqual(["Caio Novo"]);
		const again = await req("DELETE", `/v1/waitlist/${id}`);
		expect(again.status).toBe(404);
		expect(((await again.json()) as { error: string }).error).toBe(
			"Essa pessoa não está mais na lista",
		);
		expect((await req("DELETE", "/v1/waitlist/x")).status).toBe(400);
		// PATCH de quem saiu → mesma mensagem
		const p = await req("PATCH", `/v1/waitlist/${id}`, { status: "served" });
		expect(p.status).toBe(404);
	});

	it("validações do adicionar", async () => {
		const d = day(6);
		const [arq] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164, deleted_at)
      VALUES (${bizId}, 'Arquivada', '5511987650020', now()) RETURNING id`;
		for (const client_id of [arq?.id, "nao-uuid", 42]) {
			const r = await req("POST", "/v1/waitlist", {
				client_id,
				desired_date: d,
			});
			expect(r.status).toBe(404);
			expect(((await r.json()) as { error: string }).error).toBe(
				"Cliente não encontrado",
			);
		}
		const semDia = await req("POST", "/v1/waitlist", { client_id: arq?.id });
		expect(semDia.status).toBe(400);
		const semNome = await req("POST", "/v1/waitlist", {
			phone: "11987650021",
			desired_date: d,
		});
		expect(((await semNome.json()) as { error: string }).error).toBe(
			"Informe o nome",
		);
		const quebrado = await app.request("/v1/waitlist", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: "quebrado{",
		});
		expect(quebrado.status).toBe(400);
	});
});

describe("vaga aberta usa o dia no fuso do negócio", () => {
	it("cancelar às 22h (BRT) avisa a lista DAQUELE dia, não do seguinte", async () => {
		// daqui a 4 dias, 22h em São Paulo = 01h UTC do dia seguinte
		const d = day(4);
		const starts = new Date(`${d}T22:00:00-03:00`);
		expect(starts.toISOString().slice(0, 10)).not.toBe(d);
		await req("POST", "/v1/waitlist", {
			name: "Dani Espera",
			phone: "11987650030",
			desired_date: d,
		});
		const [svc] = await sql<{ id: string }[]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${bizId}, 'Corte WL2', 30, 4000) RETURNING id`;
		const [cli] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${bizId}, 'Quem cancela', '5511987650031') RETURNING id`;
		const [ap] = await sql<{ id: string }[]>`
      INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status)
      VALUES (${bizId}, ${cli?.id ?? ""}, ${svc?.id ?? ""}, ${userId}, ${starts},
              ${new Date(starts.getTime() + 1_800_000)}, 'confirmed') RETURNING id`;
		sendToUserMock.mockClear();
		const res = await req("PATCH", `/v1/appointments/${ap?.id}`, {
			status: "canceled",
		});
		expect(res.status).toBe(200);
		await vi.waitFor(() =>
			expect(sendToUserMock).toHaveBeenCalledWith(
				DATABASE_URL,
				userId,
				"Vaga abriu — lista de espera",
				`1 cliente na espera para ${d.slice(8, 10)}/${d.slice(5, 7)}. Toque para avisar.`,
				expect.objectContaining({ type: "waitlist", date: d }),
			),
		);
	});
});

describe("link público", () => {
	it("página tem o botão da lista de espera", async () => {
		const res = await app.request(`/p/${slug}`);
		const html = await res.text();
		expect(html).toContain('id="wl"');
		expect(html).toContain("Não achou horário? Entrar na lista de espera");
		expect(html).toContain("'/v1/p/'+SLUG+'/waitlist'");
		expect(html).toContain("Você está na lista de espera!");
	});
});

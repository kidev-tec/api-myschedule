/**
 * 0021 — kits (combos) de serviço: criar/editar com itens, validações,
 * listagem com itens, exclusão de serviço que está em kit (409 / arquivar
 * junto), agendamento do kit e link público.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({ getApps: vi.fn(() => [{} as never]) }));

import { createApp } from "../../src/app.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";
const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = Date.now() % 100_000;
const uid = () => `kit-uid-${seq++}`;
function authed(u: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Kit" };
	});
	return { Authorization: `Bearer ${u}` };
}

type Svc = {
	id: string;
	name: string;
	duration_min: number;
	price_cents: number;
	is_kit: boolean;
	items?: { id: string; name: string }[];
};

let h: Record<string, string>;
let slug: string;
const req = (method: string, path: string, body?: unknown) =>
	app.request(path, {
		method,
		headers: { "content-type": "application/json", ...h },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const svc = async (name: string, dur = 30, price = 4000) =>
	(await (
		await req("POST", "/v1/services", {
			name,
			duration_min: dur,
			price_cents: price,
		})
	).json()) as Svc;
const kit = (name: string, items: unknown, dur = 50, price = 6000) =>
	req("POST", "/v1/services", {
		name,
		duration_min: dur,
		price_cents: price,
		items,
	});

beforeAll(async () => {
	h = authed(uid());
	const sync = await req("POST", "/v1/auth/sync", { name: `Pro Kit ${seq}` });
	slug = ((await sync.json()) as { business: { slug: string } }).business.slug;
	await sql`
    INSERT INTO working_hours (user_id, weekday, start_time, end_time)
    SELECT id, 1, '09:00', '18:00' FROM users WHERE firebase_uid = ${h.Authorization?.slice(7) ?? ""}`;
});

afterAll(async () => {
	const ids = await sql<
		{ business_id: string }[]
	>`SELECT business_id FROM users WHERE email LIKE 'kit-uid-%'`;
	for (const { business_id } of ids) {
		await sql`DELETE FROM appointments WHERE business_id = ${business_id}`;
		await sql`DELETE FROM clients WHERE business_id = ${business_id}`;
		await sql`DELETE FROM service_kit_items WHERE kit_id IN (SELECT id FROM services WHERE business_id = ${business_id})`;
		await sql`DELETE FROM services WHERE business_id = ${business_id}`;
	}
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'kit-uid-%')`;
	await sql`DELETE FROM users WHERE email LIKE 'kit-uid-%'`;
	for (const { business_id } of ids) {
		await sql`DELETE FROM businesses WHERE id = ${business_id}`;
	}
	await sql.end();
});

describe("kits de serviço", () => {
	it("cria kit com itens (preço/duração livres) e lista com itens", async () => {
		const corte = await svc("Corte", 30, 5000);
		const barba = await svc("Barba", 20, 3000);
		const res = await kit("Corte + Barba", [corte.id, barba.id], 45, 7000);
		expect(res.status).toBe(201);
		const k = (await res.json()) as Svc;
		expect(k.is_kit).toBe(true);
		expect(k.duration_min).toBe(45);
		expect(k.price_cents).toBe(7000);
		expect(k.items?.map((i) => i.name)).toEqual(["Corte", "Barba"]);

		const list = (await (await req("GET", "/v1/services")).json()) as Svc[];
		const fromList = list.find((s) => s.id === k.id);
		expect(fromList?.items?.map((i) => i.id)).toEqual([corte.id, barba.id]);
		const plain = list.find((s) => s.id === corte.id);
		expect(plain?.is_kit).toBe(false);
		expect(plain && "items" in plain).toBe(false);

		const one = (await (
			await req("GET", `/v1/services/${k.id}`)
		).json()) as Svc;
		expect(one.items).toHaveLength(2);
	});

	it("valida os itens do kit", async () => {
		const a = await svc("A");
		const b = await svc("B");
		const arquivado = await svc("Arquivado");
		await req("DELETE", `/v1/services/${arquivado.id}`);
		const outroKit = (await (await kit("K1", [a.id, b.id])).json()) as Svc;

		const casos: [unknown, string][] = [
			["x", "Escolha os serviços do kit"],
			[[a.id, 7], "Escolha os serviços do kit"],
			[[a.id, a.id], "duas vezes"],
			[[a.id], "de 2 a 10"],
			[Array.from({ length: 11 }, () => crypto.randomUUID()), "de 2 a 10"],
			[[a.id, crypto.randomUUID()], "não existe mais"],
			[[a.id, arquivado.id], "não existe mais"],
			[[a.id, outroKit.id], "outro kit dentro"],
		];
		for (const [items, msg] of casos) {
			const res = await kit("Inválido", items);
			expect(res.status, JSON.stringify(items)).toBe(400);
			expect(((await res.json()) as { error: string }).error).toContain(msg);
		}
	});

	it("PATCH troca itens só de kit; kit não inclui a si mesmo", async () => {
		const a = await svc("PA");
		const b = await svc("PB");
		const c2 = await svc("PC");
		const k = (await (await kit("PK", [a.id, b.id])).json()) as Svc;

		const troca = await req("PATCH", `/v1/services/${k.id}`, {
			items: [c2.id, a.id],
		});
		expect(troca.status).toBe(200);
		expect(((await troca.json()) as Svc).items?.map((i) => i.name)).toEqual([
			"PC",
			"PA",
		]);

		const comNome = await req("PATCH", `/v1/services/${k.id}`, {
			name: "PK2",
			items: [a.id, b.id],
		});
		expect(((await comNome.json()) as Svc).name).toBe("PK2");

		expect(
			(await req("PATCH", `/v1/services/${k.id}`, { items: [k.id, a.id] }))
				.status,
		).toBe(400);
		expect(
			(await req("PATCH", `/v1/services/${k.id}`, { items: [a.id] })).status,
		).toBe(400);
		const naoKit = await req("PATCH", `/v1/services/${a.id}`, {
			items: [b.id, c2.id],
		});
		expect(naoKit.status).toBe(400);
		expect(((await naoKit.json()) as { error: string }).error).toContain(
			"Só kits",
		);
		expect(
			(
				await req("PATCH", `/v1/services/${crypto.randomUUID()}`, {
					name: "x",
				})
			).status,
		).toBe(404);
	});

	it("excluir serviço que está em kit: 409 com os kits; ?kits=archive arquiva junto", async () => {
		const a = await svc("DA");
		const b = await svc("DB");
		const k = (await (await kit("DK", [a.id, b.id])).json()) as Svc;

		const bloq = await req("DELETE", `/v1/services/${a.id}`);
		expect(bloq.status).toBe(409);
		const body = (await bloq.json()) as {
			error: string;
			kits: { id: string }[];
		};
		expect(body.error).toContain('do kit "DK"');
		expect(body.kits.map((x) => x.id)).toEqual([k.id]);

		// dois kits → mensagem no plural
		const k2 = (await (await kit("DK2", [a.id, b.id])).json()) as Svc;
		const plural = (await (
			await req("DELETE", `/v1/services/${a.id}`)
		).json()) as { error: string };
		expect(plural.error).toContain("dos kits");

		const junto = await req("DELETE", `/v1/services/${a.id}?kits=archive`);
		expect(junto.status).toBe(200);
		const arch = (await junto.json()) as {
			archived_kits: { id: string }[];
		};
		expect(arch.archived_kits.map((x) => x.id).sort()).toEqual(
			[k.id, k2.id].sort(),
		);
		const list = (await (await req("GET", "/v1/services")).json()) as Svc[];
		expect(list.some((s) => [a.id, k.id, k2.id].includes(s.id))).toBe(false);

		// serviço fora de kit (ou kit) exclui direto
		expect((await req("DELETE", `/v1/services/${b.id}`)).status).toBe(200);
		expect(
			(await req("DELETE", `/v1/services/${crypto.randomUUID()}`)).status,
		).toBe(404);
	});

	it("kit é agendável e aparece no link público com o que inclui", async () => {
		const a = await svc("Corte <b>", 30, 5000);
		const b = await svc("Sobrancelha", 15, 2000);
		const k = (await (
			await kit("Combo", [a.id, b.id], 45, 6500)
		).json()) as Svc;
		const [client] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      SELECT business_id, 'Cli Kit', ${`+55119${String(seq).padStart(8, "0")}`}
      FROM users WHERE firebase_uid = ${h.Authorization?.slice(7) ?? ""} RETURNING id`;
		const appt = await req("POST", "/v1/appointments", {
			clientId: client?.id,
			serviceId: k.id,
			startsAt: "2026-11-02T13:00:00.000Z",
			duration_min: 45,
		});
		expect(appt.status).toBe(201);

		const info = (await (await app.request(`/p/${slug}/info`)).json()) as {
			services: {
				id: string;
				price_cents: number;
				items?: string[];
				items_total_cents?: number;
			}[];
		};
		// soma dos itens (R$ 70) > preço do kit (R$ 65): link mostra "de/por"
		const kInfo = info.services.find((s) => s.id === k.id);
		expect(kInfo?.items_total_cents).toBe(7000);
		expect(kInfo?.price_cents).toBe(6500);
		expect(info.services.find((s) => s.id === k.id)?.items).toEqual([
			"Corte <b>",
			"Sobrancelha",
		]);
		expect(info.services.find((s) => s.id === a.id)?.items).toBeUndefined();

		// HTML escapa os nomes (vêm do cadastro)
		const html = await (await app.request(`/p/${slug}`)).text();
		expect(html).toContain("const esc = v =>");
		expect(html).toContain("s.items.map(esc)");
		expect(html).toContain("s.items_total_cents>s.price_cents");
	});

	it("vários serviços num horário só: kit oculto reaproveitado (app e link)", async () => {
		const a = await svc("Barba C", 20, 3000);
		const b = await svc("Corte C", 30, 5000);
		const k = (await (await kit("Kit C", [a.id, b.id])).json()) as Svc;
		const [client] = await sql<{ id: string }[]>`
      INSERT INTO clients (business_id, name, phone_e164)
      SELECT business_id, 'Cli Combo', ${`+55118${String(seq).padStart(8, "0")}`}
      FROM users WHERE firebase_uid = ${h.Authorization?.slice(7) ?? ""} RETURNING id`;
		const post = (startsAt: string, serviceIds: unknown, dur = 50) =>
			req("POST", "/v1/appointments", {
				clientId: client?.id,
				serviceIds,
				startsAt,
				duration_min: dur,
			});

		// app: 2 serviços → 1 agendamento "Barba C + Corte C"
		const r1 = await post("2026-11-02T15:00:00.000Z", [a.id, b.id]);
		expect(r1.status).toBe(201);
		const ap1 = (await r1.json()) as { appointment: { serviceId: string } };
		const [combo] = await sql<
			{
				name: string;
				duration_min: number;
				price_cents: number;
				adhoc: boolean;
				archived_at: Date | null;
			}[]
		>`SELECT name, duration_min, price_cents, adhoc, archived_at FROM services WHERE id = ${ap1.appointment.serviceId}`;
		expect(combo?.name).toBe("Barba C + Corte C");
		expect(combo?.duration_min).toBe(50);
		expect(combo?.price_cents).toBe(8000);
		expect(combo?.adhoc).toBe(true);
		expect(combo?.archived_at).not.toBeNull(); // oculto das listas

		// mesma combinação reaproveita (e atualiza preço atual)
		await req("PATCH", `/v1/services/${a.id}`, { price_cents: 3500 });
		const r2 = await post("2026-11-02T17:00:00.000Z", [a.id, b.id]);
		const ap2 = (await r2.json()) as { appointment: { serviceId: string } };
		expect(ap2.appointment.serviceId).toBe(ap1.appointment.serviceId);
		const [upd] = await sql<{ price_cents: number }[]>`
      SELECT price_cents FROM services WHERE id = ${ap2.appointment.serviceId}`;
		expect(upd?.price_cents).toBe(8500);
		// ordem diferente = outra combinação (nome "Corte C + Barba C")
		const r3 = await post("2026-11-02T19:00:00.000Z", [b.id, a.id]);
		const ap3 = (await r3.json()) as { appointment: { serviceId: string } };
		expect(ap3.appointment.serviceId).not.toBe(ap1.appointment.serviceId);

		// não aparece na lista de serviços
		const list = (await (await req("GET", "/v1/services")).json()) as Svc[];
		expect(list.some((s) => s.id === ap1.appointment.serviceId)).toBe(false);

		// 1 item em serviceIds = serviceId normal
		const r4 = await post("2026-11-02T20:00:00.000Z", [a.id], 20);
		expect(r4.status).toBe(201);
		expect(
			((await r4.json()) as { appointment: { serviceId: string } }).appointment
				.serviceId,
		).toBe(a.id);

		// kit não combina com outros; inválidos dão 400 com mensagem humana
		const kk = await post("2026-11-03T15:00:00.000Z", [a.id, k.id]);
		expect(kk.status).toBe(400);
		expect(((await kk.json()) as { error: string }).error).toContain(
			"escolha o kit sozinho",
		);
		const dup = await post("2026-11-03T15:00:00.000Z", [a.id, a.id]);
		expect(((await dup.json()) as { error: string }).error).toBe(
			"O mesmo serviço aparece duas vezes",
		);
		const muitos = await post(
			"2026-11-03T15:00:00.000Z",
			Array.from({ length: 11 }, () => crypto.randomUUID()),
		);
		expect(((await muitos.json()) as { error: string }).error).toBe(
			"Escolha de 2 a 10 serviços",
		);
		const semCliente = await req("POST", "/v1/appointments", {
			serviceIds: [a.id, b.id],
			startsAt: "2026-11-03T15:00:00.000Z",
			duration_min: 50,
		});
		expect(semCliente.status).toBe(400);

		// link público: service_ids → horário só, com o mesmo kit oculto
		const book = (body: Record<string, unknown>) =>
			app.request(`/p/${slug}/book`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: "Cli Pub",
					phone: "11977776666",
					starts_at: "2026-11-09T13:00:00.000Z",
					...body,
				}),
			});
		const pb = await book({ service_ids: [a.id, b.id] });
		expect(pb.status).toBe(201);
		const pbody = (await pb.json()) as { service: string; ends_at: string };
		expect(pbody.service).toBe("Barba C + Corte C");
		expect(pbody.ends_at).toBe("2026-11-09T13:50:00.000Z");
		expect((await book({ service_ids: [a.id, k.id] })).status).toBe(400);
		expect(
			(
				await book({
					service_ids: [b.id],
					starts_at: "2026-11-09T16:00:00.000Z",
				})
			).status,
		).toBe(201);
		expect((await book({ service_ids: ["x"] })).status).toBe(400);

		// nome longo é cortado em 120 caracteres com "…"
		const l1 = await svc("L".repeat(70), 5, 100);
		const l2 = await svc("M".repeat(70), 5, 100);
		const rl = await post("2026-11-02T18:00:00.000Z", [l1.id, l2.id], 10);
		const longo = (await rl.json()) as { appointment: { serviceId: string } };
		const [nm] = await sql<{ name: string }[]>`
      SELECT name FROM services WHERE id = ${longo.appointment.serviceId}`;
		expect(nm?.name).toHaveLength(120);
		expect(nm?.name.endsWith("…")).toBe(true);

		const html = await (await app.request(`/p/${slug}`)).text();
		expect(html).toContain("service_ids: SEL");
	});
});

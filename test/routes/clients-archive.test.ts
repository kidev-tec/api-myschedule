/**
 * Clientes: celular repetido (só dígitos, com/sem 55, inclui arquivados),
 * aviso de agendamentos futuros, arquivar (com ou sem cancelar os futuros),
 * lista de arquivados, reativar e histórico preservado.
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

const u = `arcl-uid-${Date.now() % 100_000}`;
const h = { Authorization: `Bearer ${u}` };
let bizId = "";
let userId = "";
let serviceId = "";

const req = (method: string, path: string, body?: unknown) =>
	app.request(path, {
		method,
		headers: { "content-type": "application/json", ...h },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

type Cli = { id: string; name: string; archived: boolean };
const create = async (name: string, phone: string) =>
	(await (
		await req("POST", "/v1/clients", { name, phone_e164: phone })
	).json()) as Cli;

beforeAll(async () => {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Arcl" };
	});
	const sync = await req("POST", "/v1/auth/sync", { name: `Pro Arcl ${u}` });
	bizId = ((await sync.json()) as { business: { id: string } }).business.id;
	const [usr] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE firebase_uid = ${u}`;
	userId = usr?.id ?? "";
	const [svc] = await sql<{ id: string }[]>`
    INSERT INTO services (business_id, name, duration_min, price_cents)
    VALUES (${bizId}, 'Corte', 30, 4000) RETURNING id`;
	serviceId = svc?.id ?? "";
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id = ${bizId}`;
	await sql`DELETE FROM clients WHERE business_id = ${bizId}`;
	await sql`DELETE FROM services WHERE business_id = ${bizId}`;
	await sql`DELETE FROM users WHERE id = ${userId}`;
	await sql`DELETE FROM businesses WHERE id = ${bizId}`;
	await sql.end();
});

async function appt(
	clientId: string,
	daysFromNow: number,
	status = "confirmed",
) {
	const start = new Date(Date.now() + daysFromNow * 86_400_000);
	const [a] = await sql<{ id: string }[]>`
    INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status)
    VALUES (${bizId}, ${clientId}, ${serviceId}, ${userId}, ${start},
            ${new Date(start.getTime() + 1_800_000)}, ${status}) RETURNING id`;
	return a?.id ?? "";
}

describe("celular repetido ao criar/editar", () => {
	it("mesmo celular (com/sem 55, com máscara) → 409 com o cliente existente", async () => {
		const maria = await create("Maria", "5511987650101");
		for (const phone of ["11987650101", "+55 (11) 98765-0101"]) {
			const res = await req("POST", "/v1/clients", {
				name: "Outra",
				phone_e164: phone,
			});
			expect(res.status, phone).toBe(409);
			const b = (await res.json()) as {
				error: string;
				archived: boolean;
				existing: Cli;
			};
			expect(b.error).toBe("Esse celular já é de Maria");
			expect(b.archived).toBe(false);
			expect(b.existing.id).toBe(maria.id);
		}
		// editar outro cliente pro celular da Maria também barra
		const joao = await create("João", "5511987650102");
		const res = await req("PATCH", `/v1/clients/${joao.id}`, {
			name: "João",
			phone_e164: "(11) 98765-0101",
		});
		expect(res.status).toBe(409);
		// editar a própria Maria mantendo o celular passa
		const ok = await req("PATCH", `/v1/clients/${maria.id}`, {
			name: "Maria Silva",
			phone_e164: "11987650101",
		});
		expect(ok.status).toBe(200);
	});
});

describe("arquivar, listar arquivados, reativar", () => {
	it("aviso de futuros, arquivar sem cancelar, histórico e agenda preservados", async () => {
		const ana = await create("Ana", "5511987650201");
		const futuro = await appt(ana.id, 3);
		await appt(ana.id, 5, "canceled"); // cancelado não conta
		const passado = await appt(ana.id, -3, "done");

		const up = (await (
			await req("GET", `/v1/clients/${ana.id}/upcoming`)
		).json()) as { upcoming: { id: string; service_name: string }[] };
		expect(up.upcoming.map((x) => x.id)).toEqual([futuro]);
		expect(up.upcoming[0]?.service_name).toBe("Corte");

		const del = await req("DELETE", `/v1/clients/${ana.id}`);
		expect(del.status).toBe(200);
		const d = (await del.json()) as Cli & { canceled_appointments: number };
		expect(d.archived).toBe(true);
		expect(d.canceled_appointments).toBe(0);

		// agendamento futuro segue ativo; cliente abre por id e o histórico existe
		const [st] = await sql<{ status: string }[]>`
      SELECT status FROM appointments WHERE id = ${futuro}`;
		expect(st?.status).toBe("confirmed");
		const got = (await (
			await req("GET", `/v1/clients/${ana.id}`)
		).json()) as Cli;
		expect(got.archived).toBe(true);
		const hist = (await (
			await req("GET", `/v1/clients/${ana.id}/history`)
		).json()) as { total: number; recent: { id: string }[] };
		expect(hist.total).toBe(3);
		expect(hist.recent.map((r) => r.id)).toContain(passado);

		// lista de ativos não tem; arquivados tem (sem o cliente técnico do bloqueio)
		await req("POST", "/v1/appointments", {
			startsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(),
			endsAt: new Date(Date.now() + 9 * 86_400_000 + 1_800_000).toISOString(),
			source: "block",
		});
		const ativos = (await (await req("GET", "/v1/clients")).json()) as Cli[];
		expect(ativos.some((x) => x.id === ana.id)).toBe(false);
		const arq = (await (
			await req("GET", "/v1/clients?archived=1")
		).json()) as Cli[];
		expect(arq.map((x) => x.name)).toEqual(["Ana"]);

		// celular de arquivado: criar outro → 409 sugerindo reativar
		const dup = await req("POST", "/v1/clients", {
			name: "Ana 2",
			phone_e164: "11987650201",
		});
		expect(dup.status).toBe(409);
		const db = (await dup.json()) as { archived: boolean; error: string };
		expect(db.archived).toBe(true);
		expect(db.error).toBe("Esse celular já é de Ana (cliente arquivado)");

		// reativar
		const rest = await req("POST", `/v1/clients/${ana.id}/restore`);
		expect(rest.status).toBe(200);
		expect(((await rest.json()) as Cli).archived).toBe(false);
		const ativos2 = (await (await req("GET", "/v1/clients")).json()) as Cli[];
		expect(ativos2.some((x) => x.id === ana.id)).toBe(true);
		// reativar quem não está arquivado → 404
		expect((await req("POST", `/v1/clients/${ana.id}/restore`)).status).toBe(
			404,
		);
	});

	it("arquivar com cancel_future=1 cancela só os futuros ativos", async () => {
		const bia = await create("Bia", "5511987650301");
		const f1 = await appt(bia.id, 2);
		const f2 = await appt(bia.id, 4, "pending");
		const p1 = await appt(bia.id, -2, "confirmed");
		const del = await req("DELETE", `/v1/clients/${bia.id}?cancel_future=1`);
		const d = (await del.json()) as { canceled_appointments: number };
		expect(d.canceled_appointments).toBe(2);
		const rows = await sql<
			{ id: string; status: string; canceled_reason: string | null }[]
		>`
      SELECT id, status, canceled_reason FROM appointments WHERE client_id = ${bia.id}`;
		const by = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(by[f1]?.status).toBe("canceled");
		expect(by[f1]?.canceled_reason).toBe("cliente arquivado");
		expect(by[f2]?.status).toBe("canceled");
		expect(by[p1]?.status).toBe("confirmed"); // passado não mexe
	});

	it("arquivar sem futuros e com cancel_future=1 → 0 cancelados", async () => {
		const caio = await create("Caio", "5511987650401");
		const d = (await (
			await req("DELETE", `/v1/clients/${caio.id}?cancel_future=1`)
		).json()) as { canceled_appointments: number };
		expect(d.canceled_appointments).toBe(0);
	});

	it("reativar com outro cliente ATIVO usando o celular → 409", async () => {
		const dani = await create("Dani", "5511987650501");
		await req("DELETE", `/v1/clients/${dani.id}`);
		// cadastro antigo sem 55 com o mesmo número, criado por fora
		await sql`
      INSERT INTO clients (business_id, name, phone_e164)
      VALUES (${bizId}, 'Dani Nova', '11987650501')`;
		const res = await req("POST", `/v1/clients/${dani.id}/restore`);
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toBe(
			"Esse celular já é de Dani Nova",
		);
	});

	it("ids inválidos e inexistentes", async () => {
		const ghost = "00000000-0000-4000-8000-000000000000";
		expect((await req("GET", "/v1/clients/x/upcoming")).status).toBe(400);
		expect((await req("POST", "/v1/clients/x/restore")).status).toBe(400);
		expect((await req("DELETE", `/v1/clients/${ghost}`)).status).toBe(404);
		expect((await req("POST", `/v1/clients/${ghost}/restore`)).status).toBe(
			404,
		);
		expect((await req("GET", `/v1/clients/${ghost}`)).status).toBe(404);
	});
});

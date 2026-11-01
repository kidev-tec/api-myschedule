/**
 * Ranking de clientes: conta concluído + pendente/confirmado que já passou;
 * ignora cancelado, falta, futuro e bloqueio; ordena por atendimentos
 * (desempate: total gasto, último atendimento); filtro de período.
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

const u = `rank-uid-${Date.now() % 100_000}`;
const h = { Authorization: `Bearer ${u}` };
let bizId = "";
let userId = "";
let corte = "";
let barba = "";

const get = async (path: string) => app.request(path, { headers: h });

type Row = {
	position: number;
	name: string;
	visits: number;
	total_cents: number;
	archived: boolean;
	last_visit: string;
};

beforeAll(async () => {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== u) throw new Error("invalid");
		return { uid: u, email: `${u}@t.com`, name: "Pro Rank" };
	});
	const sync = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `Pro Rank ${u}` }),
	});
	bizId = ((await sync.json()) as { business: { id: string } }).business.id;
	userId =
		(
			await sql<
				{ id: string }[]
			>`SELECT id FROM users WHERE firebase_uid = ${u}`
		)[0]?.id ?? "";
	corte =
		(
			await sql<{ id: string }[]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${bizId}, 'Corte', 30, 5000) RETURNING id`
		)[0]?.id ?? "";
	barba =
		(
			await sql<{ id: string }[]>`
      INSERT INTO services (business_id, name, duration_min, price_cents)
      VALUES (${bizId}, 'Barba', 20, 3000) RETURNING id`
		)[0]?.id ?? "";

	const cli = async (name: string, phone: string, archived = false) =>
		(
			await sql<{ id: string }[]>`
        INSERT INTO clients (business_id, name, phone_e164, deleted_at)
        VALUES (${bizId}, ${name}, ${phone}, ${archived ? new Date() : null})
        RETURNING id`
		)[0]?.id ?? "";
	const ana = await cli("Ana", "5511900000001");
	const bia = await cli("Bia", "5511900000002");
	const caio = await cli("Caio", "5511900000003", true); // arquivado
	const dani = await cli("Dani", "5511900000004");
	const bloq = await cli("— bloqueio —", "", true);

	let n = 0;
	const appt = async (
		clientId: string,
		daysAgo: number,
		status: string,
		serviceId = corte,
		source = "app",
	) => {
		// minutos distintos evitam o EXCLUDE de sobreposição
		const start = new Date(Date.now() - daysAgo * 86_400_000 + n++ * 3_600_000);
		await sql`
      INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status, source)
      VALUES (${bizId}, ${clientId}, ${serviceId}, ${userId}, ${start},
              ${new Date(start.getTime() + 600_000)}, ${status}, ${source})`;
	};
	// Ana: 3 atendimentos (done, confirmado passado, pendente passado)
	await appt(ana, 100, "done");
	await appt(ana, 10, "confirmed");
	await appt(ana, 5, "pending", barba);
	// e coisas que NÃO contam
	await appt(ana, 4, "canceled");
	await appt(ana, 3, "noshow");
	await appt(ana, -5, "confirmed"); // futuro
	// Bia: 2 atendimentos, ambos antigos (fora dos 30 dias)
	await appt(bia, 200, "done");
	await appt(bia, 60, "done");
	// Caio (arquivado): 2 atendimentos recentes, R$ 100 — empata com a Bia
	// em visitas mas gasta mais
	await appt(caio, 8, "done");
	await appt(caio, 7, "done");
	// Dani: só futuro → fora do ranking
	await appt(dani, -10, "confirmed");
	// bloqueio passado não conta
	await appt(bloq, 2, "confirmed", corte, "block");
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id = ${bizId}`;
	await sql`DELETE FROM clients WHERE business_id = ${bizId}`;
	await sql`DELETE FROM services WHERE business_id = ${bizId}`;
	await sql`DELETE FROM users WHERE id = ${userId}`;
	await sql`DELETE FROM businesses WHERE id = ${bizId}`;
	await sql.end();
});

describe("GET /v1/clients/ranking", () => {
	it("sempre: ordem por atendimentos, desempate por total gasto", async () => {
		const res = await get("/v1/clients/ranking");
		expect(res.status).toBe(200);
		const { period, ranking } = (await res.json()) as {
			period: string;
			ranking: Row[];
		};
		expect(period).toBe("all");
		expect(
			ranking.map((r) => [r.position, r.name, r.visits, r.total_cents]),
		).toEqual([
			[1, "Ana", 3, 13000],
			[2, "Caio", 2, 10000],
			[3, "Bia", 2, 10000],
		]);
		expect(ranking[1]?.archived).toBe(true);
		expect(ranking.some((r) => r.name === "Dani")).toBe(false);
	});

	it("30 dias e 12 meses filtram pelo horário do atendimento", async () => {
		// Caio e Bia empatam em visitas e valor (R$ 100): desempate pelo
		// atendimento mais recente (Caio, 7 dias)
		const r30 = (await (await get("/v1/clients/ranking?period=30")).json()) as {
			ranking: Row[];
		};
		// 30 dias: empate em 2 → Caio (R$ 100) na frente da Ana (R$ 80)
		expect(r30.ranking.map((r) => [r.name, r.visits, r.total_cents])).toEqual([
			["Caio", 2, 10000],
			["Ana", 2, 8000],
		]);
		const r365 = (await (
			await get("/v1/clients/ranking?period=365")
		).json()) as {
			ranking: Row[];
		};
		expect(r365.ranking.map((r) => [r.name, r.visits])).toEqual([
			["Ana", 3],
			["Caio", 2],
			["Bia", 2], // 200 e 60 dias atrás: dentro de 12 meses
		]);
	});

	it("limit e period inválido", async () => {
		const one = (await (await get("/v1/clients/ranking?limit=1")).json()) as {
			ranking: Row[];
		};
		expect(one.ranking).toHaveLength(1);
		const bad = (await (await get("/v1/clients/ranking?limit=abc")).json()) as {
			ranking: Row[];
		};
		expect(bad.ranking).toHaveLength(3);
		expect((await get("/v1/clients/ranking?period=7")).status).toBe(400);
	});
});

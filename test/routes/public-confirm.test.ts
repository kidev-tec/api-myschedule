/**
 * RF-B02..B04 — Confirmação de presença do cliente via link público.
 * GET /p/:slug/confirm/:appointmentId?token=HMAC(id+startsAt)
 * - token válido: "Vou comparecer" → confirmed; "Não posso" → canceled
 * - idempotente: 2ª chamada não quebra (200)
 * - token inválido → 403
 * Mesmo padrão de public-booking.test.ts: Postgres real, Firebase mockado.
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
import { confirmationToken } from "../../src/domain/confirmation-token.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-confirm-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Confirm" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function one<T>(q: Promise<{ id: string }[]>): Promise<T> {
	const rows = await q;
	return rows[0] as T;
}

/** Amanhã 09:00 — horário futuro válido pra confirmação. */
const when = () => {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	d.setHours(9, 0, 0, 0);
	return d;
};

describe("RF-B — confirmação do cliente via link (token HMAC)", () => {
	let h: Record<string, string>;
	let slug: string;
	let clientId: string;
	let serviceId: string;
	let professionalId: string;

	beforeAll(async () => {
		await sql`SELECT 1`;
		h = authed(uid());
		const sync = await app.request("/v1/auth/sync", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Pro Confirm Suite" }),
		});
		expect(sync.status).toBe(201);
		const body = (await sync.json()) as {
			business: { id: string; slug: string };
		};
		slug = body.business.slug;
		professionalId = (
			await one<{ id: string }>(sql`
				SELECT id FROM users WHERE business_id = ${body.business.id} LIMIT 1`)
		).id;

		clientId = (
			await one<{ id: string }>(sql`
			INSERT INTO clients (business_id, name, phone_e164)
			VALUES (${body.business.id}, 'Confirm Fake', '+5511999990002') RETURNING id`)
		).id;
		serviceId = (
			await one<{ id: string }>(sql`
			INSERT INTO services (business_id, name, duration_min, price_cents)
			VALUES (${body.business.id}, 'Corte Confirm', 30, 5000) RETURNING id`)
		).id;
	});

	afterAll(async () => {
		await sql`DELETE FROM appointments WHERE client_id = ${clientId}`;
		await sql`DELETE FROM clients WHERE id = ${clientId}`;
		await sql`DELETE FROM services WHERE id = ${serviceId}`;
		await sql`DELETE FROM users WHERE business_id IN (SELECT id FROM businesses WHERE name = 'Pro Confirm Suite')`;
		await sql`DELETE FROM businesses WHERE name = 'Pro Confirm Suite'`;
		await sql.end();
	});

	let slotSeq = 0;
	/** cria appointment pending direto no banco (status controlável). Cada
	 *  chamada usa um slot de 10min diferente pra não violar a exclusion constraint. */
	async function createPending(): Promise<{ id: string; startsAt: Date }> {
		const startsAt = new Date(when().getTime() + slotSeq * 60 * 60_000);
		slotSeq++;
		const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
		const row = await one<{ id: string }>(sql`
			INSERT INTO appointments (business_id, client_id, service_id, user_id, starts_at, ends_at, status, source)
			VALUES (
				(SELECT id FROM businesses WHERE name = 'Pro Confirm Suite'),
				${clientId}, ${serviceId}, ${professionalId}, ${startsAt}, ${endsAt}, 'pending', 'public_link'
			) RETURNING id`);
		return { id: row.id, startsAt };
	}

	it("RF-B02: 'Vou comparecer' (decide=confirm) muda pending → confirmed", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);

		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=${token}&decide=confirm`,
		);
		expect(res.status).toBe(200);

		const [row] = await sql`
			SELECT status FROM appointments WHERE id = ${appt.id}`;
		expect((row as { status: string }).status).toBe("confirmed");
	});

	it("RF-B02b: 'Não posso mais' (decide=cancel) muda pending → canceled com motivo", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);

		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=${token}&decide=cancel`,
		);
		expect(res.status).toBe(200);

		const [row] = await sql`
			SELECT status, canceled_reason FROM appointments WHERE id = ${appt.id}`;
		const r = row as { status: string; canceled_reason: string };
		expect(r.status).toBe("canceled");
		expect(r.canceled_reason).toBe("cliente cancelou via link");
	});

	it("RF-B03: token inválido → 403, status não muda", async () => {
		const appt = await createPending();
		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=INVALIDO&decide=confirm`,
		);
		expect(res.status).toBe(403);
		const [row] = await sql`
			SELECT status FROM appointments WHERE id = ${appt.id}`;
		expect((row as { status: string }).status).toBe("pending");
	});

	it("RF-B04: idempotente — confirmar 2x retorna 200 e não quebra", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);
		const url = `/p/${slug}/confirm/${appt.id}?token=${token}&decide=confirm`;

		const r1 = await app.request(url);
		expect(r1.status).toBe(200);
		const r2 = await app.request(url);
		expect(r2.status).toBe(200);
		const [row] = await sql`
			SELECT status FROM appointments WHERE id = ${appt.id}`;
		expect((row as { status: string }).status).toBe("confirmed");
	});

	it("RF-B04b: appointment inexistente → 404", async () => {
		const fakeId = "00000000-0000-4000-8000-000000000000";
		const token = confirmationToken(fakeId, when());
		const res = await app.request(
			`/p/${slug}/confirm/${fakeId}?token=${token}&decide=confirm`,
		);
		expect(res.status).toBe(404);
	});

	it("decide inválido → 400", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);
		const bad = await app.request(
			`/p/${slug}/confirm/${appt.id}?token=${token}&decide=talvez`,
		);
		expect(bad.status).toBe(400);
	});

	describe("página do link do WhatsApp (sem decide)", () => {
		const page = (id: string, token: string, s = slug) =>
			app.request(`/p/${s}/confirm/${id}?token=${token}`);
		const statusOf = async (id: string) =>
			(
				(await sql`SELECT status FROM appointments WHERE id = ${id}`)[0] as {
					status: string;
				}
			).status;

		it("abrir o link mostra os botões e não muda nada", async () => {
			const appt = await createPending();
			const token = confirmationToken(appt.id, appt.startsAt);
			const res = await page(appt.id, token);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			const html = await res.text();
			expect(html).toContain("Olá, Confirm! Você vem?");
			expect(html).toContain("Corte Confirm em Pro Confirm Suite");
			expect(html).toContain("Vou comparecer");
			expect(html).toContain("Não vou poder");
			expect(html).toContain(`decide=confirm`);
			expect(html).not.toContain("decide inválido");
			// horário no fuso do negócio, por extenso
			const when = appt.startsAt.toLocaleString("pt-BR", {
				weekday: "long",
				day: "2-digit",
				month: "long",
				hour: "2-digit",
				minute: "2-digit",
				timeZone: "America/Sao_Paulo",
			});
			expect(html).toContain(when);
			expect(await statusOf(appt.id)).toBe("pending");
		});

		it("nome do cliente é escapado; sem nome, cumprimenta sem nome", async () => {
			const appt = await createPending();
			const token = confirmationToken(appt.id, appt.startsAt);
			const rename = (name: string) =>
				sql`UPDATE clients SET name = ${name} WHERE id = ${clientId}`;
			try {
				await rename("<b>Zé&'\" Silva");
				const html = await (await page(appt.id, token)).text();
				expect(html).toContain("Olá, &lt;b&gt;Zé&amp;&#39;&quot;! Você vem?");
				await rename("   ");
				expect(await (await page(appt.id, token)).text()).toContain(
					"Olá! Você vem?",
				);
			} finally {
				await rename("Confirm Fake");
			}
		});

		it("botão Vou comparecer: confirma, volta pra página e não repete", async () => {
			const appt = await createPending();
			const token = confirmationToken(appt.id, appt.startsAt);
			const url = `/p/${slug}/confirm/${appt.id}?token=${token}`;
			const res = await app.request(`${url}&decide=confirm`, {
				method: "POST",
			});
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe(url);
			expect(await statusOf(appt.id)).toBe("confirmed");
			const html = await (await app.request(url)).text();
			expect(html).toContain("Presença confirmada!");
			expect(html).not.toContain("Vou comparecer");

			// já confirmado: "não vou poder" não cancela nem finge que cancelou
			await app.request(`${url}&decide=cancel`, { method: "POST" });
			expect(await statusOf(appt.id)).toBe("confirmed");
		});

		it("botão Não vou poder: cancela e oferece outro horário", async () => {
			const appt = await createPending();
			const token = confirmationToken(appt.id, appt.startsAt);
			const url = `/p/${slug}/confirm/${appt.id}?token=${token}`;
			await app.request(`${url}&decide=cancel`, { method: "POST" });
			expect(await statusOf(appt.id)).toBe("canceled");
			const html = await (await app.request(url)).text();
			expect(html).toContain("Agendamento cancelado");
			expect(html).toContain("Agendar outro horário");
		});

		it("horário que já passou: sem botões e o POST não muda", async () => {
			const appt = await createPending();
			const past = new Date(Date.now() - 5 * 86_400_000 + slotSeq * 3_600_000);
			await sql`UPDATE appointments
				SET starts_at = ${past}, ends_at = ${new Date(past.getTime() + 1_800_000)}
				WHERE id = ${appt.id}`;
			const token = confirmationToken(appt.id, past);
			const url = `/p/${slug}/confirm/${appt.id}?token=${token}`;
			const html = await (await app.request(url)).text();
			expect(html).toContain("Esse horário já passou");
			expect(html).not.toContain("Vou comparecer");
			const res = await app.request(`${url}&decide=confirm`, {
				method: "POST",
			});
			expect(res.status).toBe(303);
			expect(await statusOf(appt.id)).toBe("pending");
		});

		it("POST sem decide válido só volta pra página", async () => {
			const appt = await createPending();
			const token = confirmationToken(appt.id, appt.startsAt);
			const res = await app.request(
				`/p/${slug}/confirm/${appt.id}?token=${token}&decide=talvez`,
				{ method: "POST" },
			);
			expect(res.status).toBe(303);
			expect(await statusOf(appt.id)).toBe("pending");
		});

		it("link velho (remarcou), id e slug errados: página amigável", async () => {
			const appt = await createPending();
			const old = await page(appt.id, "token-velho");
			expect(old.status).toBe(403);
			const html = await old.text();
			expect(html).toContain("Este link não vale mais");
			expect(html).toContain("Fale com Pro Confirm Suite");
			const post = await app.request(
				`/p/${slug}/confirm/${appt.id}?token=velho&decide=confirm`,
				{ method: "POST" },
			);
			expect(post.status).toBe(403);
			const semToken = await app.request(
				`/p/${slug}/confirm/${appt.id}?decide=confirm`,
				{ method: "POST" },
			);
			expect(semToken.status).toBe(403);
			expect(await statusOf(appt.id)).toBe("pending");

			const ghost = "00000000-0000-4000-8000-000000000000";
			for (const res of [
				await page(ghost, "x"),
				await page("nao-e-uuid", "x"),
				await page(appt.id, "x", "slug-fantasma"),
			]) {
				expect(res.status).toBe(404);
				expect(await res.text()).toContain("Agendamento não encontrado");
			}
		});
	});

	it("token ausente → 403", async () => {
		const appt = await createPending();
		const res = await app.request(
			`/p/${slug}/confirm/${appt.id}?decide=confirm`,
		);
		expect(res.status).toBe(403);
	});

	it("slug inexistente → 404", async () => {
		const appt = await createPending();
		const token = confirmationToken(appt.id, appt.startsAt);
		const res = await app.request(
			`/p/slug-fantasma/confirm/${appt.id}?token=${token}&decide=confirm`,
		);
		expect(res.status).toBe(404);
	});
});

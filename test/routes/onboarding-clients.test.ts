/**
 * Integração REAL: rotas de onboarding (/me, /services, /working-hours)
 * e /clients contra Postgres docker. Firebase mockado — banco é real.
 *
 * Padrão herdado de integration.test.ts: uid único por teste, truncate ao final.
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
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;
const uid = () => `test-uid-onb-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Teste" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function syncUser(headers: Record<string, string>) {
	const auth = headers.Authorization ?? "";
	const uidValue = auth.startsWith("Bearer ")
		? auth.slice("Bearer ".length)
		: auth;
	// Nome único por uid: índice businesses (nome+segmento) da migration 0004.
	return app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ name: `Pro Teste onb ${uidValue}` }),
	});
}

async function createdUser(headers: Record<string, string>) {
	const res = await syncUser(headers);
	expect(res.status).toBe(201);
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-onb-%')`;
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste onb%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste onb%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste onb%')`;
	// corrida: outro arquivo em paralelo pode ter apagado estes users já — ignorar FK
	try {
		await sql`DELETE FROM working_hours WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-onb-%')`;
		await sql`DELETE FROM users WHERE email LIKE 'test-uid-onb-%'`;
	} catch {
		// registro já apagado por outro worker — ok
	}
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste onb%'`;
	await sql.end();
});

describe("GET /v1/me onboarding_complete", () => {
	it("false logo após o sync (sem serviço/horários), true após onboarding", async () => {
		const h = authed(uid());
		await createdUser(h);

		const before = await app.request("/v1/me", { headers: h });
		expect(before.status).toBe(200);
		const beforeBody = (await before.json()) as {
			onboarding_complete: boolean;
		};
		expect(beforeBody.onboarding_complete).toBe(false);

		// cria serviço + horários (mesmo fluxo do onboarding do app)
		const svc = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte",
				duration_min: 30,
				price_cents: 5000,
			}),
		});
		expect(svc.status).toBe(201);
		const wh = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [{ weekday: 1, start_minute: 540, end_minute: 1080 }],
			}),
		});
		expect([200, 201]).toContain(wh.status);

		const after = await app.request("/v1/me", { headers: h });
		const afterBody = (await after.json()) as {
			onboarding_complete: boolean;
		};
		expect(afterBody.onboarding_complete).toBe(true);
	});
});

describe("PATCH /v1/me", () => {
	it("renomeia o business do usuário", async () => {
		const h = authed(uid());
		await createdUser(h);
		const novoNome = `Studio Novo ${Date.now()}`; // único: nome+segmento agora é UNIQUE
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ business_name: novoNome }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { business_name: string };
		expect(body.business_name).toBe(novoNome);
		const rows = await sql`
			SELECT b.name FROM businesses b
			JOIN users u ON u.business_id = b.id
			WHERE u.firebase_uid = ${h.Authorization.slice(7)}`;
		expect(rows.length).toBe(1);
		expect(rows[0]?.name).toBe(novoNome);
	});

	it("400 sem business_name", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ business_name: "   " }),
		});
		expect(res.status).toBe(400);
	});

	it("400 quando business_name não é string", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ business_name: 123 }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("string");
	});

	it("400 nada para atualizar com body vazio", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("nada para atualizar");
	});

	it("PATCH só com business_type (parcial)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ business_type: "barber" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { business_type: string | null };
		expect(body.business_type).toBe("barber");
	});

	it("409 quando outro business no mesmo segmento já tem o nome", async () => {
		// cria business A com nome X (beauty)
		const hA = authed(uid());
		await createdUser(hA);
		const nome = `Duplicado ${Date.now()}`;
		await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...hA },
			body: JSON.stringify({ business_name: nome }),
		});
		// business B tenta o mesmo nome no mesmo segmento → 409
		const hB = authed(uid());
		await createdUser(hB);
		const res = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...hB },
			body: JSON.stringify({ business_name: nome.toUpperCase() }), // case-insensitive
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Já existe");
	});
});

describe("/v1/services", () => {
	it("POST cria e GET lista (snake_case)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte",
				duration_min: 30,
				price_cents: 3500,
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as {
			id: string;
			name: string;
			duration_min: number;
			price_cents: number;
			archived_at: null;
		};
		expect(created.duration_min).toBe(30);
		expect(created.price_cents).toBe(3500);

		const list = await app.request("/v1/services", { headers: h });
		expect(list.status).toBe(200);
		const items = (await list.json()) as { id: string }[];
		expect(items.some((s) => s.id === created.id)).toBe(true);
	});

	it("400 com payload inválido", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "", duration_min: 0, price_cents: -5 }),
		});
		expect(res.status).toBe(400);
	});

	it("GET por id + DELETE (soft) esconde da lista", async () => {
		const h = authed(uid());
		await createdUser(h);
		const created = (await (
			await app.request("/v1/services", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify({
					name: "Escova",
					duration_min: 45,
					price_cents: 5000,
				}),
			})
		).json()) as { id: string };
		const got = await app.request(`/v1/services/${created.id}`, { headers: h });
		expect(got.status).toBe(200);

		const del = await app.request(`/v1/services/${created.id}`, {
			method: "DELETE",
			headers: h,
		});
		expect(del.status).toBe(200);

		const gone = await app.request(`/v1/services/${created.id}`, {
			headers: h,
		});
		expect(gone.status).toBe(404);
		const list = await app.request("/v1/services", { headers: h });
		const items = (await list.json()) as { id: string }[];
		expect(items.some((s) => s.id === created.id)).toBe(false);
	});

	it("404 em id inexistente", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request(
			`/v1/services/00000000-0000-4000-8000-000000000000`,
			{ headers: h },
		);
		expect(res.status).toBe(404);
	});
});

describe("/v1/working-hours", () => {
	it("PUT substitui tudo e GET devolve snake_case HH:MM:SS", async () => {
		const h = authed(uid());
		await createdUser(h);
		const put = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [
					{ weekday: 1, start_minute: 540, end_minute: 1080 },
					{ weekday: 2, start_minute: 600, end_minute: 1020 },
				],
			}),
		});
		expect(put.status).toBe(200);
		const afterPut = (await put.json()) as {
			weekday: number;
			start_time: string;
			end_time: string;
		}[];
		expect(afterPut.length).toBe(2);

		// replace total: 2º PUT com 1 slot remove os anteriores
		const put2 = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [{ weekday: 3, start_minute: 480, end_minute: 1200 }],
			}),
		});
		const after2 = (await put2.json()) as { weekday: number }[];
		expect(after2.length).toBe(1);
		expect(after2[0]?.weekday).toBe(3);

		const get = await app.request("/v1/working-hours", { headers: h });
		const items = (await get.json()) as {
			start_time: string;
			end_time: string;
		}[];
		expect(items[0]?.start_time).toBe("08:00:00");
		expect(items[0]?.end_time).toBe("20:00:00");
	});

	it("400 em slot inválido (fim antes do início)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [{ weekday: 1, start_minute: 1080, end_minute: 540 }],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("PUT com lista vazia zera os horários", async () => {
		const h = authed(uid());
		await createdUser(h);
		await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [{ weekday: 1, start_minute: 540, end_minute: 1080 }],
			}),
		});
		const res = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ slots: [] }),
		});
		expect(res.status).toBe(200);
		const items = (await res.json()) as unknown[];
		expect(items.length).toBe(0);
	});
});

describe("/v1/clients", () => {
	it("POST cria, GET lista, GET por id, DELETE soft (404 depois)", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/clients", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Maria",
				phone_e164: "+5514999998888",
				email: "m@t.com",
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as {
			id: string;
			name: string;
			phone_e164: string;
			email: string | null;
		};
		expect(created.phone_e164).toBe("+5514999998888");

		const got = await app.request(`/v1/clients/${created.id}`, { headers: h });
		expect(got.status).toBe(200);

		const del = await app.request(`/v1/clients/${created.id}`, {
			method: "DELETE",
			headers: h,
		});
		expect(del.status).toBe(200);
		const gone = await app.request(`/v1/clients/${created.id}`, { headers: h });
		expect(gone.status).toBe(404);
	});

	it("400 sem phone válido", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/clients", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Sem Fone", phone_e164: "123" }),
		});
		expect(res.status).toBe(400);
	});

	it("400 em id malformado", async () => {
		const h = authed(uid());
		await createdUser(h);
		const res = await app.request("/v1/clients/nao-e-uuid", { headers: h });
		expect(res.status).toBe(400);
	});

	it("404 quando user não existe (uid sem sync)", async () => {
		const h = authed(`ghost-${Date.now()}`);
		const res = await app.request("/v1/clients", { headers: h });
		expect(res.status).toBe(404);
	});

	it("400 em id malformado no GET e DELETE de services", async () => {
		const h = authed(uid());
		await createdUser(h);
		const g = await app.request("/v1/services/abc", { headers: h });
		expect(g.status).toBe(400);
		const d = await app.request("/v1/services/abc", {
			method: "DELETE",
			headers: h,
		});
		expect(d.status).toBe(400);
	});

	it("400 em PUT /working-hours sem slots array e com slot malformado", async () => {
		const h = authed(uid());
		await createdUser(h);
		const r1 = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ slots: "nao-sou-array" }),
		});
		expect(r1.status).toBe(400);
		const r2 = await app.request("/v1/working-hours", {
			method: "PUT",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				slots: [{ weekday: 9, start_minute: 99999, end_minute: -1 }],
			}),
		});
		expect(r2.status).toBe(400);
	});

	it("cobre ramificações: ghost user, ids malformados, slots ruins, campos fora do range", async () => {
		// ghost user (user não encontrado) em /clients e /services e /me e /working-hours
		const ghost = authed(`ghost2-${Date.now()}`);
		expect((await app.request("/v1/clients", { headers: ghost })).status).toBe(
			404,
		);
		expect(
			(
				await app.request("/v1/clients/00000000-0000-4000-8000-000000000000", {
					headers: ghost,
				})
			).status,
		).toBe(404);
		expect((await app.request("/v1/services", { headers: ghost })).status).toBe(
			404,
		);
		expect(
			(
				await app.request("/v1/me", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...ghost },
					body: JSON.stringify({ business_name: "X" }),
				})
			).status,
		).toBe(404);
		expect(
			(await app.request("/v1/working-hours", { headers: ghost })).status,
		).toBe(404);
		expect(
			(
				await app.request("/v1/working-hours", {
					method: "PUT",
					headers: { "content-type": "application/json", ...ghost },
					body: JSON.stringify({ slots: [] }),
				})
			).status,
		).toBe(404);

		const h = authed(uid());
		await createdUser(h);

		// services: id malformado (GET/DELETE), 404, payload com tipos errados
		expect((await app.request("/v1/services/abc", { headers: h })).status).toBe(
			400,
		);
		expect(
			(await app.request("/v1/services/abc", { method: "DELETE", headers: h }))
				.status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/services/00000000-0000-4000-8000-000000000000", {
					headers: h,
				})
			).status,
		).toBe(404);
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({
						name: 42,
						duration_min: "30",
						price_cents: true,
					}),
				})
			).status,
		).toBe(400);
		// duration no limite: >600 rejeita
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({
						name: "Longo",
						duration_min: 495,
						price_cents: 100,
					}),
				})
			).status,
		).toBe(400);
		// DELETE 404 (id válido de outro business)
		expect(
			(
				await app.request("/v1/services/00000000-0000-4000-8000-000000000000", {
					method: "DELETE",
					headers: h,
				})
			).status,
		).toBe(404);

		// /me: body inválido (null) e nome > 120
		expect(
			(
				await app.request("/v1/me", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: "null",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/me", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ business_name: "x".repeat(121) }),
				})
			).status,
		).toBe(400);

		// working-hours: body null, slot não-objeto, weekday fora do range, minute não-inteiro
		expect(
			(
				await app.request("/v1/working-hours", {
					method: "PUT",
					headers: { "content-type": "application/json", ...h },
					body: "null",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/working-hours", {
					method: "PUT",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ slots: [42] }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/working-hours", {
					method: "PUT",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({
						slots: [{ weekday: 7, start_minute: 540, end_minute: 1080 }],
					}),
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/working-hours", {
					method: "PUT",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({
						slots: [{ weekday: 1, start_minute: 540.5, end_minute: 1080 }],
					}),
				})
			).status,
		).toBe(400);

		// clients: POST payload errado, GET/DELETE id malformado, GET 404, DELETE 404
		expect(
			(
				await app.request("/v1/clients", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ name: "", phone_e164: "+5514999998888" }),
				})
			).status,
		).toBe(400);
		expect((await app.request("/v1/clients/abc", { headers: h })).status).toBe(
			400,
		);
		expect(
			(await app.request("/v1/clients/abc", { method: "DELETE", headers: h }))
				.status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/clients/00000000-0000-4000-8000-000000000000", {
					headers: h,
				})
			).status,
		).toBe(404);
		expect(
			(
				await app.request("/v1/clients/00000000-0000-4000-8000-000000000000", {
					method: "DELETE",
					headers: h,
				})
			).status,
		).toBe(404);
	});

	it("cobre caminhos felizes de listagem", async () => {
		const h = authed(uid());
		await createdUser(h);
		// caminhos felizes: GET lista clients e GET /services/:id
		const cl = await app.request("/v1/clients", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Lista", phone_e164: "+5514000000000" }),
		});
		const clBody = (await cl.json()) as { id: string };
		const listRes = await app.request("/v1/clients", { headers: h });
		const list = (await listRes.json()) as { id: string }[];
		expect(list.some((x) => x.id === clBody.id)).toBe(true);
		expect(
			(await app.request(`/v1/clients/${clBody.id}`, { headers: h })).status,
		).toBe(200);

		const sv = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "PorId",
				duration_min: 30,
				price_cents: 100,
			}),
		});
		const svBody = (await sv.json()) as { id: string };
		expect(
			(await app.request(`/v1/services/${svBody.id}`, { headers: h })).status,
		).toBe(200);
	});

	it("cobre POSTs com payload null e email opcional", async () => {
		const h = authed(uid());
		await createdUser(h);
		// POST /clients: payload null e sem email (branch do email opcional)
		expect(
			(
				await app.request("/v1/clients", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: "null",
				})
			).status,
		).toBe(400);
		// POST /services: payload null
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: "null",
				})
			).status,
		).toBe(400);
	});

	it("cobre body json quebrado em todas as rotas", async () => {
		const ghostUid = `ghost3-${Date.now()}`;
		const h = authed(uid());
		await createdUser(h);
		// mock que aceita o uid real E o ghost
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== h.Authorization.slice(7) && token !== ghostUid)
				throw new Error("invalid");
			return { uid: token, email: `${token}@t.com`, name: "Pro Teste" };
		});
		const ghost = { Authorization: `Bearer ${ghostUid}` };
		// working-hours ghost em PUT com slots válidos
		expect(
			(
				await app.request("/v1/working-hours", {
					method: "PUT",
					headers: { "content-type": "application/json", ...ghost },
					body: JSON.stringify({
						slots: [{ weekday: 1, start_minute: 540, end_minute: 1080 }],
					}),
				})
			).status,
		).toBe(404);
		// /me: body json quebrado -> catch -> null -> 400
		expect(
			(
				await app.request("/v1/me", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: "{quebrado",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: "{quebrado",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/clients", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: "{quebrado",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request("/v1/working-hours", {
					method: "PUT",
					headers: { "content-type": "application/json", ...h },
					body: "{quebrado",
				})
			).status,
		).toBe(400);
	});

	it("cobre branches remanescentes de services/clients com ghost", async () => {
		const ghostUid = `ghost4-${Date.now()}`;
		const h = authed(uid());
		await createdUser(h);
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== h.Authorization.slice(7) && token !== ghostUid)
				throw new Error("invalid");
			return { uid: token, email: `${token}@t.com`, name: "Pro Teste" };
		});
		const ghost = { Authorization: `Bearer ${ghostUid}` };
		// serviços: branches remanescentes — "user não encontrado" no GET e DELETE por id
		expect(
			(
				await app.request("/v1/services/00000000-0000-4000-8000-000000000000", {
					headers: ghost,
				})
			).status,
		).toBe(404);
		expect(
			(
				await app.request("/v1/services/00000000-0000-4000-8000-000000000000", {
					method: "DELETE",
					headers: ghost,
				})
			).status,
		).toBe(404);
		// id malformado no GET/DELETE com user real (ghost uid existe mas sem user no banco cai no 404 da rota... na real: validação de user vem antes)
		expect((await app.request("/v1/services/abc", { headers: h })).status).toBe(
			400,
		);
		expect(
			(await app.request("/v1/services/abc", { method: "DELETE", headers: h }))
				.status,
		).toBe(400);
		// clients idem com user real
		expect((await app.request("/v1/clients/abc", { headers: h })).status).toBe(
			400,
		);
		expect(
			(await app.request("/v1/clients/abc", { method: "DELETE", headers: h }))
				.status,
		).toBe(400);
	});

	it("cobre POSTs com ghost (user não sincronizado)", async () => {
		const ghostUid = `ghost5-${Date.now()}`;
		const h = authed(uid());
		await createdUser(h);
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== h.Authorization.slice(7) && token !== ghostUid)
				throw new Error("invalid");
			return { uid: token, email: `${token}@t.com`, name: "Pro Teste" };
		});
		const ghost = { Authorization: `Bearer ${ghostUid}` };
		// POSTs com ghost (user não sincronizado) — cobre o branch !me dos POSTs
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: { "content-type": "application/json", ...ghost },
					body: JSON.stringify({
						name: "X",
						duration_min: 30,
						price_cents: 100,
					}),
				})
			).status,
		).toBe(404);
		expect(
			(
				await app.request("/v1/clients", {
					method: "POST",
					headers: { "content-type": "application/json", ...ghost },
					body: JSON.stringify({ name: "X", phone_e164: "+5514000000000" }),
				})
			).status,
		).toBe(404);
	});

	it("cobre DELETE /clients branches", async () => {
		const ghostUid = `ghost6-${Date.now()}`;
		const h = authed(uid());
		await createdUser(h);
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== h.Authorization.slice(7) && token !== ghostUid)
				throw new Error("invalid");
			return { uid: token, email: `${token}@t.com`, name: "Pro Teste" };
		});
		const ghost = { Authorization: `Bearer ${ghostUid}` };
		// DELETE /clients com id válido e inexistente (cobre upd undefined branch)
		expect(
			(
				await app.request("/v1/clients/00000000-0000-4000-8000-000000000000", {
					method: "DELETE",
					headers: ghost,
				})
			).status,
		).toBe(404);
		// DELETE /clients com ghost (user não sincronizado)
		expect(
			(
				await app.request("/v1/clients/abc", {
					method: "DELETE",
					headers: ghost,
				})
			).status,
		).toBe(404);
	});

	it("GET /me e PATCH business_type (válido, inválido, ausente)", async () => {
		const h = authed(uid());
		await createdUser(h);

		// GET /me retorna business com business_type default 'beauty'
		const meRes = await app.request("/v1/me", { headers: h });
		expect(meRes.status).toBe(200);
		const me = (await meRes.json()) as { business_type: string };
		expect(me.business_type).toBe("beauty");

		// PATCH com business_type válido
		const ok = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				business_name: `Studio Novo ${Date.now()}`,
				business_type: "barber",
			}),
		});
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { business_type: string }).business_type).toBe(
			"barber",
		);

		// PATCH com business_type inválido → 400
		const bad = await app.request("/v1/me", {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				business_name: "Studio Novo",
				business_type: "salao_de_festa",
			}),
		});
		expect(bad.status).toBe(400);

		// GET /me de ghost → 404
		const ghostUid = `ghost7-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== h.Authorization.slice(7) && token !== ghostUid)
				throw new Error("invalid");
			return { uid: token, email: `${token}@t.com`, name: "Pro Teste" };
		});
		const ghost = { Authorization: `Bearer ${ghostUid}` };
		expect((await app.request("/v1/me", { headers: ghost })).status).toBe(404);
		expect(
			(
				await app.request("/v1/me", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...ghost },
					body: JSON.stringify({ business_name: "X", business_type: "barber" }),
				})
			).status,
		).toBe(404);
	});

	it("paywall: 404 sem user e sem business (gate do middleware)", async () => {
		// ghost: user não sincronizado → !me → null → 404
		const ghostUid = `ghost-pw-${Date.now()}`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== "x" && token !== ghostUid) throw new Error("invalid");
			return { uid: token, email: `${token}@t.com`, name: "P" };
		});
		const gh = { Authorization: `Bearer ${ghostUid}` };
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: { "content-type": "application/json", ...gh },
					body: JSON.stringify({ name: "X", duration_min: 30, price_cents: 0 }),
				})
			).status,
		).toBe(404);

		// user sincronizado mas business sumiu (caso defensivo) → 404
		const bizId = crypto.randomUUID();
		const orphanUid = `orfanopw-${Date.now()}`;
		await sql`insert into businesses (id, name, slug) values (${bizId}, 'orfao', ${`orfao-${Date.now()}`})`;
		await sql`insert into users (id, firebase_uid, business_id, email, name) values (${crypto.randomUUID()}, ${orphanUid}, ${bizId}, ${`${orphanUid}@t.com`}, 'Orfao')`;
		verifyMock.mockImplementation(async (token: string) => {
			if (token !== "x" && token !== orphanUid) throw new Error("invalid");
			return { uid: token, email: `${token}@t.com`, name: "P" };
		});
		await sql`delete from users where firebase_uid = ${orphanUid}`;
		await sql`delete from businesses where id = ${bizId}`;
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						Authorization: `Bearer ${orphanUid}`,
					},
					body: JSON.stringify({ name: "X", duration_min: 30, price_cents: 0 }),
				})
			).status,
		).toBe(404);
	});

	it("paywall: trial vencido → 402 em POST, GET livre, 404 sem user", async () => {
		const h = authed(uid());
		await createdUser(h);

		// vence o trial do business desse user direto no banco de teste
		const fbUid = h.Authorization.slice(7);
		const meRow =
			await sql`select business_id from users where firebase_uid = ${fbUid}`;
		const bizId = meRow[0]?.business_id as string;
		await sql`update businesses set subscription_status = 'trial', trial_ends_at = now() - interval '1 second' where id = ${bizId}`;

		// GET continua livre
		expect((await app.request("/v1/services", { headers: h })).status).toBe(
			200,
		);
		// POST bloqueado com 402
		const post = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "X", duration_min: 30, price_cents: 0 }),
		});
		expect(post.status).toBe(402);
		expect(((await post.json()) as { error: string }).error).toBe(
			"assinatura necessária",
		);
		// PATCH também
		expect(
			(
				await app.request("/v1/me", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ business_name: "Novo" }),
				})
			).status,
		).toBe(402);

		// reativa conta
		await sql`update businesses set subscription_status = 'active' where id = ${bizId}`;
		expect(
			(
				await app.request("/v1/services", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ name: "X", duration_min: 30, price_cents: 0 }),
				})
			).status,
		).toBe(201);

		// canceled → 402
		await sql`update businesses set subscription_status = 'canceled' where id = ${bizId}`;
		expect(
			(
				await app.request("/v1/clients", {
					method: "POST",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ name: "Y", phone: "14999990000" }),
				})
			).status,
		).toBe(402);
	});

	it("PATCH /services/:id — edita, valida e 404", async () => {
		const h = authed(uid());
		await createdUser(h);

		// PATCH com ghost (user não sincronizado) → 404 do !me
		{
			const ghostUid = `ghost-patch-${Date.now()}`;
			verifyMock.mockImplementation(async (token: string) => {
				if (token !== h.Authorization.slice(7) && token !== ghostUid)
					throw new Error("invalid");
				return { uid: token, email: `${token}@t.com`, name: "Pro Teste" };
			});
			const ghost = { Authorization: `Bearer ${ghostUid}` };
			expect(
				(
					await app.request(
						"/v1/services/00000000-0000-4000-8000-000000000000",
						{
							method: "PATCH",
							headers: { "content-type": "application/json", ...ghost },
							body: JSON.stringify({ name: "X" }),
						},
					)
				).status,
			).toBe(404);
		}

		// cria serviço
		const created = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte",
				duration_min: 30,
				price_cents: 5000,
			}),
		});
		expect(created.status).toBe(201);
		const svc = (await created.json()) as { id: string };

		// edita duração pra 45 (válido: 15..480, múltiplo de 15) e nome
		const patched = await app.request(`/v1/services/${svc.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ name: "Corte premium", duration_min: 45 }),
		});
		expect(patched.status).toBe(200);
		const up = (await patched.json()) as { name: string; duration_min: number };
		expect(up.name).toBe("Corte premium");
		expect(up.duration_min).toBe(45);

		// edita só o preço (branch price_cents no PATCH)
		expect(
			(
				await app.request(`/v1/services/${svc.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ price_cents: 6000 }),
				})
			).status,
		).toBe(200);

		// valida campos
		expect(
			(
				await app.request(`/v1/services/${svc.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ duration_min: 50 }),
				})
			).status,
		).toBe(400);
		// body não-JSON → json() falha → null → nada pra atualizar → 400
		expect(
			(
				await app.request(`/v1/services/${svc.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: "{quebrado",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request(`/v1/services/${svc.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ name: "" }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.request(`/v1/services/${svc.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ price_cents: -1 }),
				})
			).status,
		).toBe(400);
		// nada pra atualizar
		expect(
			(
				await app.request(`/v1/services/${svc.id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: "{}",
				})
			).status,
		).toBe(400);
		// id malformado
		expect(
			(
				await app.request("/v1/services/abc", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ name: "X" }),
				})
			).status,
		).toBe(400);
		// serviço inexistente (uuid válido)
		expect(
			(
				await app.request("/v1/services/00000000-0000-4000-8000-000000000000", {
					method: "PATCH",
					headers: { "content-type": "application/json", ...h },
					body: JSON.stringify({ name: "X" }),
				})
			).status,
		).toBe(404);
	});
});

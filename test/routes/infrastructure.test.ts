/**
 * Integração REAL dos módulos novos (logo, devices, trial-reminders)
 * contra Postgres docker. Firebase mockado; envio de email/FCM mockado.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
const sendMock = vi.hoisted(() =>
	vi.fn<
		(args: {
			token: string;
			notification: { title: string; body: string };
		}) => Promise<string>
	>(async () => "ok"),
);

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));
vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));
vi.mock("firebase-admin/messaging", () => ({
	getMessaging: () => ({ send: sendMock }),
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
const uid = () => `test-uid-logo-${Date.now()}-${seq++}`;

function authed(uidValue: string) {
	verifyMock.mockImplementation(async (token: string) => {
		if (token !== uidValue) throw new Error("invalid");
		return { uid: uidValue, email: `${uidValue}@t.com`, name: "Pro Teste" };
	});
	return { Authorization: `Bearer ${uidValue}` };
}

async function syncUser(headers: Record<string, string>) {
	return app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify({ name: `Pro Teste Logo ${Date.now()}-${seq++}` }),
	});
}

async function me(headers: Record<string, string>) {
	const r = await app.request("/v1/me", { headers });
	return r.json() as Promise<{
		slug: string;
		logo_url: string | null;
		id: string;
	}>;
}

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

beforeAll(async () => {
	await sql`SELECT 1`;
	sendMock.mockClear();
});

afterAll(async () => {
	await sql`DELETE FROM appointments WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste Logo%')`;
	await sql`DELETE FROM clients WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste Logo%')`;
	await sql`DELETE FROM device_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'test-uid-logo-%')`;
	await sql`DELETE FROM services WHERE business_id IN (SELECT id FROM businesses WHERE name LIKE 'Pro Teste Logo%')`;
	await sql`DELETE FROM users WHERE email LIKE 'test-uid-logo-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Pro Teste Logo%'`;
	await sql.end();
});

describe("POST /v1/me/logo (logo bytea)", () => {
	it("upload PNG válido → 200 {logoUrl}; GET /me retorna logo_url", async () => {
		const h = authed(uid());
		expect((await syncUser(h)).status).toBe(201);
		const profile = await me(h);
		expect(profile.logo_url).toBeNull();

		const form = new FormData();
		form.append(
			"logo",
			new Blob([new Uint8Array(PNG_1PX)], { type: "image/png" }),
			"logo.png",
		);
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: h,
			body: form,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { logoUrl: string };
		expect(body.logoUrl).toBe(`/v1/businesses/${profile.slug}/logo`);

		const after = await me(h);
		expect(after.logo_url).toBe(body.logoUrl);
	});

	it("GET /v1/businesses/:slug/logo (público) serve bytes com mime certo", async () => {
		const h = authed(uid());
		await syncUser(h);
		const form = new FormData();
		form.append(
			"logo",
			new Blob([new Uint8Array(PNG_1PX)], { type: "image/png" }),
			"logo.png",
		);
		await app.request("/v1/me/logo", {
			method: "POST",
			headers: h,
			body: form,
		});
		const { slug } = await me(h);

		const res = await app.request(`/v1/businesses/${slug}/logo`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_1PX);
	});

	it("GET logo de business sem logo → 404", async () => {
		const h = authed(uid());
		await syncUser(h);
		const { slug } = await me(h);
		const res = await app.request(`/v1/businesses/${slug}/logo`);
		expect(res.status).toBe(404);
	});

	it("tipo inválido (gif) → 400 com mensagem humana", async () => {
		const h = authed(uid());
		await syncUser(h);
		const form = new FormData();
		form.append(
			"logo",
			new Blob([new Uint8Array([1, 2, 3])], { type: "image/gif" }),
			"logo.gif",
		);
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: h,
			body: form,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("PNG ou JPG");
	});

	it("arquivo >2MB → 400", async () => {
		const h = authed(uid());
		await syncUser(h);
		const big = new Uint8Array(2 * 1024 * 1024 + 1);
		const form = new FormData();
		form.append("logo", new Blob([big], { type: "image/png" }), "big.png");
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: h,
			body: form,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("2MB");
	});

	it("campo logo como string (nao arquivo) → 400", async () => {
		const h = authed(uid());
		await syncUser(h);
		const form = new FormData();
		form.append("logo", "texto");
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: h,
			body: form,
		});
		expect(res.status).toBe(400);
		const b = (await res.json()) as { error: string };
		expect(b.error).toContain("obrigatório");
	});

	it("sem campo logo → 400", async () => {
		const h = authed(uid());
		await syncUser(h);
		const form = new FormData();
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: h,
			body: form,
		});
		expect(res.status).toBe(400);
	});

	it("content-type não multipart → 400", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: { ...h, "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const b = (await res.json()) as { error: string };
		expect(b.error).toContain("multipart");
	});

	it("sem content-type → 400 (branch header ausente)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: h,
			body: new Uint8Array([1, 2, 3]),
		});
		expect(res.status).toBe(400);
		const b = (await res.json()) as { error: string };
		expect(b.error).toContain("multipart");
	});

	it("multipart com body inválido → 400 (formData lança)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request("/v1/me/logo", {
			method: "POST",
			headers: {
				...h,
				"content-type": "multipart/form-data; boundary=----bad",
			},
			body: "----bad\r\nisto-nao-e-formdata-valido",
		});
		expect(res.status).toBe(400);
		const b = (await res.json()) as { error: string };
		expect(b.error).toContain("formulário");
	});
});

describe("POST /v1/devices (borda)", () => {
	it("body quebrado → 400", async () => {
		const h = authed(uid());
		await syncUser(h);
		const res = await app.request("/v1/devices", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: "nao e json",
		});
		expect(res.status).toBe(400);
	});
});

describe("POST/DELETE /v1/devices (registro FCM)", () => {
	it("registro válido → 201; mesmo token atualiza (upsert, sem duplicar)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const payload = {
			fcmToken: `tok-${Date.now()}-abcdefghijklmnop`,
			platform: "android",
		};

		const r1 = await app.request("/v1/devices", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify(payload),
		});
		expect(r1.status).toBe(201);

		// mesmo token, user novo → upsert (não duplica)
		const h2 = authed(uid());
		await syncUser(h2);
		const r2 = await app.request("/v1/devices", {
			method: "POST",
			headers: { "content-type": "application/json", ...h2 },
			body: JSON.stringify(payload),
		});
		expect(r2.status).toBe(201);

		const rows = await sql`
			SELECT count(*)::int AS n FROM device_tokens WHERE fcm_token = ${payload.fcmToken}
		`;
		expect(rows[0]?.n).toBe(1);
	});

	it("platform inválida → 400; token curto → 400", async () => {
		const h = authed(uid());
		await syncUser(h);
		const mk = (body: object) =>
			app.request("/v1/devices", {
				method: "POST",
				headers: { "content-type": "application/json", ...h },
				body: JSON.stringify(body),
			});
		expect(
			(await mk({ fcmToken: "abcdefghijk", platform: "web" })).status,
		).toBe(400);
		expect((await mk({ fcmToken: "curto", platform: "android" })).status).toBe(
			400,
		);
	});

	it("DELETE /devices remove o token → 204", async () => {
		const h = authed(uid());
		await syncUser(h);
		const token = `del-${Date.now()}-abcdefghijklmnop`;
		await app.request("/v1/devices", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ fcmToken: token, platform: "android" }),
		});
		const res = await app.request("/v1/devices", {
			method: "DELETE",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ fcmToken: token }),
		});
		expect(res.status).toBe(204);
		const rows = await sql`
			SELECT 1 FROM device_tokens WHERE fcm_token = ${token}
		`;
		expect(rows.length).toBe(0);
		// token curto → 400
		const bad = await app.request("/v1/devices", {
			method: "DELETE",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ fcmToken: "curto" }),
		});
		expect(bad.status).toBe(400);
		// sem body (json quebrado) -> 400
		const nb = await app.request("/v1/devices", {
			method: "DELETE",
			headers: h,
		});
		expect(nb.status).toBe(400);
		// fcmToken nao-string -> 400
		const nonstr = await app.request("/v1/devices", {
			method: "DELETE",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ fcmToken: 12345 }),
		});
		expect(nonstr.status).toBe(400);
	});
});

describe("POST /v1/internal/trial-reminders", () => {
	it("sem INTERNAL_KEY configurada → 503 (fail-closed)", async () => {
		const prev = process.env.INTERNAL_KEY;
		delete process.env.INTERNAL_KEY;
		try {
			const res = await app.request("/v1/internal/trial-reminders", {
				method: "POST",
			});
			expect(res.status).toBe(503);
		} finally {
			if (prev !== undefined) process.env.INTERNAL_KEY = prev;
		}
	});

	it("header errado → 401; header certo → envia e marca sent", async () => {
		process.env.INTERNAL_KEY = "test-secret";
		try {
			const bad = await app.request("/v1/internal/trial-reminders", {
				method: "POST",
				headers: { "x-internal-key": "errada" },
			});
			expect(bad.status).toBe(401);

			// business com trial terminando em 2 dias
			const h = authed(uid());
			await syncUser(h);
			const { id } = await me(h);
			await sql`
				UPDATE businesses
				SET trial_ends_at = now() + interval '2 days'
				WHERE id = ${id}
			`; // segundo business com trial terminando HOJE (daysLeft = 0)
			const h2 = authed(uid());
			await syncUser(h2);
			const me2 = await me(h2);
			await sql`
				UPDATE businesses
				SET trial_ends_at = now() + interval '4 hours'
				WHERE id = ${me2.id}
			`;

			const ok = await app.request("/v1/internal/trial-reminders", {
				method: "POST",
				headers: { "x-internal-key": "test-secret" },
			});
			expect(ok.status).toBe(200);
			const body = (await ok.json()) as { sent: number; checked: number };
			expect(body.checked).toBeGreaterThanOrEqual(1);
			expect(body.sent).toBeGreaterThanOrEqual(1);
			expect(sendMock).not.toHaveBeenCalled(); // email, não push

			// segunda chamada imediata NÃO reenvia (trial_reminder_sent_at)
			const again = await app.request("/v1/internal/trial-reminders", {
				method: "POST",
				headers: { "x-internal-key": "test-secret" },
			});
			const b2 = (await again.json()) as { sent: number };
			expect(b2.sent).toBe(0);
		} finally {
			delete process.env.INTERNAL_KEY;
		}
	});
});

describe("push no booking público (B3)", () => {
	it("POST /p/:slug/book dispara sendToUser pro dono (mock FCM chamado)", async () => {
		const h = authed(uid());
		await syncUser(h);
		const { slug, id } = await me(h);

		// registra device do dono
		const token = `owner-${Date.now()}-abcdefghijklmnop`;
		await app.request("/v1/devices", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({ fcmToken: token, platform: "android" }),
		});

		// serviço
		const svcRes = await app.request("/v1/services", {
			method: "POST",
			headers: { "content-type": "application/json", ...h },
			body: JSON.stringify({
				name: "Corte",
				duration_min: 30,
				price_cents: 1000,
			}),
		});
		const svc = (await svcRes.json()) as { id: string };

		// horário segunda 9h (garante working hour pra slot válido não é preciso
		// pro POST direto; começa no futuro)
		const start = new Date(Date.now() + 24 * 3600 * 1000);
		start.setHours(14, 0, 0, 0);

		const res = await app.request(`/p/${slug}/book`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Cliente Push",
				phone: "+5511999990001",
				service_id: svc.id,
				starts_at: start.toISOString(),
			}),
		});
		expect(res.status).toBe(201);

		// best-effort async: dá um tick pro microtask rodar
		await new Promise((r) => setTimeout(r, 50));
		expect(sendMock).toHaveBeenCalled();
		const call = sendMock.mock.calls[0]?.[0] as unknown as {
			token: string;
			notification: { title: string; body: string };
		};
		expect(call.token).toBe(token);
		expect(call.notification.title).toContain("agendamento");
		expect(call.notification.body).toContain("Cliente Push");
	});
});

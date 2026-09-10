/**
 * Testes do middleware Firebase Auth (mockado — sem rede).
 * Coverage 100% obrigatória (RNF Qualidade).
 *
 * Estratégia: o middleware delega para firebase-admin. Extraímos a lógica
 * testável (extração do header, shape da resposta 401) e mockamos
 * verifyIdToken via vi.mock para cobrir os 3 caminhos: ausente, inválido, ok.
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyMock = vi.hoisted(() => vi.fn());
const adminInitMock = vi.hoisted(() => ({
	getApps: vi.fn(() => [{} as never]), // já inicializado → initFirebaseAdmin é no-op
}));

vi.mock("firebase-admin/auth", () => ({
	getAuth: () => ({ verifyIdToken: verifyMock }),
}));

vi.mock("firebase-admin/app", () => adminInitMock);

import { firebaseAuthMiddleware } from "../../src/middleware/auth.js";

function makeApp() {
	const app = new Hono();
	app.use("*", firebaseAuthMiddleware("test-project", undefined));
	app.get("/ping", (c) => c.json({ user: c.get("authUser") }));
	return app;
}

beforeEach(() => {
	verifyMock.mockReset();
});

describe("firebaseAuthMiddleware", () => {
	it("401 quando Authorization ausente", async () => {
		const res = await makeApp().request("/ping");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("token ausente");
	});

	it("401 quando header não é Bearer", async () => {
		const res = await makeApp().request("/ping", {
			headers: { Authorization: "Basic abc" },
		});
		expect(res.status).toBe(401);
	});

	it("401 com hint quando verifyIdToken falha (token inválido/expirado)", async () => {
		verifyMock.mockRejectedValue(new Error("expired"));
		const res = await makeApp().request("/ping", {
			headers: { Authorization: "Bearer bad-token" },
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string; hint: string };
		expect(body.hint).toContain("Refaça o login");
		expect(verifyMock).toHaveBeenCalledWith("bad-token", true);
	});

	it("anexa authUser no contexto quando token válido", async () => {
		verifyMock.mockResolvedValue({
			uid: "fb-123",
			email: "pro@test.com",
			name: "Pro",
		});
		const res = await makeApp().request("/ping", {
			headers: { Authorization: "Bearer good-token" },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			user: { uid: string; email?: string };
		};
		expect(body.user.uid).toBe("fb-123");
		expect(body.user.email).toBe("pro@test.com");
	});
});

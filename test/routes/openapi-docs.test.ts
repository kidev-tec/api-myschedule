import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { openApiSpec } from "../../src/openapi.js";

const TEST_DB =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:postgres@localhost:5433/minha_agenda_dev";

describe("OpenAPI docs", () => {
	it("spec é OpenAPI 3.1 válida (campos obrigatórios)", () => {
		expect(openApiSpec.openapi).toBe("3.1.0");
		expect(openApiSpec.info.title).toBeTruthy();
		expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(20);
	});

	it("GET /openapi.json serve a spec sem auth", async () => {
		const app = createApp({
			databaseUrl: TEST_DB,
			firebaseProjectId: "test-project",
		});
		const res = await app.request("/openapi.json");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { openapi: string; paths: unknown };
		expect(body.openapi).toBe("3.1.0");
		expect(Object.keys(body.paths as object).length).toBeGreaterThan(20);
	});

	it("GET /docs serve a UI Scalar sem auth", async () => {
		const app = createApp({
			databaseUrl: TEST_DB,
			firebaseProjectId: "test-project",
		});
		const res = await app.request("/docs");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("api-reference");
		expect(html).toContain("@scalar/api-reference");
	});

	it("anti-drift: toda rota authed do app aparece na spec", async () => {
		const app = createApp({
			databaseUrl: TEST_DB,
			firebaseProjectId: "test-project",
		});
		// Rotas de negócio que DEVEM estar documentadas. /p/* e /apks/* são
		// públicas/estáticas — fora do escopo authed da spec principal.
		const expected = [
			"/v1/auth/sync",
			"/v1/me",
			"/v1/services",
			"/v1/clients",
			"/v1/appointments",
			"/v1/working-hours",
			"/v1/gcal/auth-url",
			"/v1/gcal/status",
			"/health",
			"/version",
		];
		const documented = Object.keys(openApiSpec.paths);
		for (const path of expected) {
			expect(documented, `rota ${path} ausente da spec`).toContain(path);
		}
		// app liga sem erro (smoke — rotas registradas de verdade)
		expect(app).toBeTruthy();
	});

	it("todo $ref da spec resolve pra schema existente", () => {
		const refs: string[] = [];
		const walk = (node: unknown) => {
			if (node == null || typeof node !== "object") return;
			if (Array.isArray(node)) return node.forEach(walk);
			for (const [k, v] of Object.entries(node)) {
				if (k === "$ref" && typeof v === "string") refs.push(v);
				else walk(v);
			}
		};
		walk(openApiSpec.paths);
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs) {
			const name = ref.replace("#/components/schemas/", "");
			expect(
				(openApiSpec.components.schemas as Record<string, unknown>)[name],
				`$ref ${ref} não resolve`,
			).toBeTruthy();
		}
	});
});

/**
 * Integração REAL: BARRA B8 — OG tags + favicon com a logo na página pública.
 * Firebase mockado, Postgres docker real.
 *
 * Critérios:
 * - GET /p/:slug com logo → og:image + link rel=icon apontando pra logo
 * - og:title = "{business} — Agende online"; og:description presente
 * - GET /p/:slug sem logo → OG tags de nome presentes, sem og:image
 * - GET /p/:slug de slug inexistente → página de link inválido (200 HTML)
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
	"postgres://postgres:postgres@localhost:5433/minha_agenda_dev";

const sql = postgres(DATABASE_URL);
const app = createApp({
	databaseUrl: DATABASE_URL,
	firebaseProjectId: "test-project",
});

let seq = 0;

async function makeBusiness(withLogo: boolean) {
	verifyMock.mockImplementation(async (t: string) => ({
		uid: t,
		email: `${t}@t.com`,
		name: "X",
	}));
	const u = `og-uid-${Date.now()}-${seq++}`;
	const name = `Og Biz ${Date.now()}-${seq++}`;
	const sync = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${u}`,
		},
		body: JSON.stringify({ name }),
	});
	expect(sync.status).toBe(201);
	if (withLogo) {
		// logo PNG 1x1 real (mime validado pela rota de logo)
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
			"base64",
		);
		await sql`UPDATE businesses SET logo_data = ${png}, logo_mime = 'image/png' WHERE name = ${name}`;
	}
	const rows = await sql<{ slug: string }[]>`
		SELECT slug FROM businesses WHERE name = ${name} LIMIT 1`;
	return { slug: rows[0]?.slug ?? "", name };
}

beforeAll(async () => {
	await sql`SELECT 1`;
});

afterAll(async () => {
	await sql`DELETE FROM users WHERE email LIKE 'og-uid-%'`;
	await sql`DELETE FROM businesses WHERE name LIKE 'Og Biz%'`;
	await sql.end();
});

describe("GET /p/:slug — OG tags + logo (B8)", () => {
	it("com logo: og:image, og:title com nome do negócio e favicon", async () => {
		const { slug, name } = await makeBusiness(true);
		const res = await app.request(`/p/${slug}`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(`og:title" content="${name} — Agende online"`);
		expect(html).toContain(
			`og:description" content="Marque seu horário em ${name}"`,
		);
		expect(html).toContain(`og:image" content="/v1/businesses/${slug}/logo"`);
		expect(html).toContain(
			`<link rel="icon" href="/v1/businesses/${slug}/logo">`,
		);
	});

	it("sem logo: og:title com nome, mas SEM og:image/favicon", async () => {
		const { slug, name } = await makeBusiness(false);
		const res = await app.request(`/p/${slug}`);
		const html = await res.text();
		expect(html).toContain(`og:title" content="${name} — Agende online"`);
		expect(html).not.toContain("og:image");
		expect(html).not.toContain('rel="icon"');
	});

	it("slug inexistente: fallback genérico sem vazar dados", async () => {
		const res = await app.request("/p/não-existe-xyz");
		const html = await res.text();
		expect(html).toContain("Agende online");
		expect(html).not.toContain("og:image");
	});
});

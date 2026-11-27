/**
 * Fixtures compartilhadas dos testes do módulo de finanças (F2+).
 * O mock do Firebase fica em cada arquivo de teste (vi.mock é por arquivo):
 * aqui só registramos o uid em `known`, que o mock aceita como token válido.
 */
import type postgres from "postgres";
import { expect } from "vitest";

type App = {
	request: (path: string, init?: RequestInit) => Response | Promise<Response>;
};

export type FinBase = {
	h: Record<string, string>;
	businessId: string;
	userId: string;
	clientId: string;
	serviceId: string;
};

let seq = 0;

export async function setupBusiness(
	app: App,
	sql: postgres.Sql,
	known: Set<string>,
	prefix: string,
): Promise<FinBase> {
	const u = `${prefix}-uid-${Date.now()}-${seq++}`;
	known.add(u);
	const h = { Authorization: `Bearer ${u}` };
	const res = await app.request("/v1/auth/sync", {
		method: "POST",
		headers: { "content-type": "application/json", ...h },
		body: JSON.stringify({ name: `${prefix} ${u}` }),
	});
	expect(res.status).toBe(201);
	const [me] = await sql<{ businessId: string; userId: string }[]>`
    SELECT b.id AS "businessId", u.id AS "userId" FROM businesses b
    JOIN users u ON u.business_id = b.id WHERE u.firebase_uid = ${u}`;
	if (!me) throw new Error("negócio não criado");
	const [client] = await sql<{ id: string }[]>`
    INSERT INTO clients (business_id, name, phone_e164)
    VALUES (${me.businessId}, 'Ana', ${`+55119${String(40000000 + seq).slice(0, 8)}`})
    RETURNING id`;
	const [service] = await sql<{ id: string }[]>`
    INSERT INTO services (business_id, name, duration_min, price_cents)
    VALUES (${me.businessId}, 'Escova', 30, 10000) RETURNING id`;
	if (!client || !service) throw new Error("fixtures");
	return { h, ...me, clientId: client.id, serviceId: service.id };
}

export function jsonReq(
	app: App,
	h: Record<string, string>,
	method: string,
	path: string,
	body?: unknown,
) {
	return app.request(path, {
		method,
		headers: { "content-type": "application/json", ...h },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export async function errorOf(res: Response) {
	return ((await res.json()) as { error: string }).error;
}

/** Remove tudo dos negócios de teste cujo nome começa com [prefix]. */
export async function cleanup(sql: postgres.Sql, prefix: string) {
	const biz = sql`SELECT id FROM businesses WHERE name LIKE ${`${prefix} %`}`;
	await sql`DELETE FROM transactions WHERE business_id IN (${biz})`;
	await sql`DELETE FROM cash_sessions WHERE business_id IN (${biz})`;
	await sql`DELETE FROM appointments WHERE business_id IN (${biz})`;
	await sql`DELETE FROM clients WHERE business_id IN (${biz})`;
	await sql`DELETE FROM users WHERE email LIKE ${`${prefix}-uid-%`}`;
	await sql`DELETE FROM services WHERE business_id IN (${biz})`;
	await sql`DELETE FROM businesses WHERE name LIKE ${`${prefix} %`}`;
	await sql.end();
}

/**
 * Conexão Drizzle com o Postgres (Supabase em prod, docker em dev).
 * Lazy singleton — o pool só abre no primeiro uso.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

let client: postgres.Sql | undefined;

export function getDb(databaseUrl: string) {
	if (!client) {
		client = postgres(databaseUrl, {
			// Supabase pooler funciona bem com poucas conexões por instância serverless
			max: 10,
			idle_timeout: 20,
			connect_timeout: 10,
		});
	}
	return drizzle(client, { schema });
}

export type Db = ReturnType<typeof getDb>;
export { schema };

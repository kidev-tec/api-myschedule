// Entrypoint — env validada + serve HTTP
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { validateEnv } from "./config/env.js";

const env = validateEnv(process.env as Record<string, string | undefined>);

const app = createApp({
	databaseUrl: env.DATABASE_URL,
	firebaseProjectId: env.FIREBASE_PROJECT_ID,
	firebaseServiceAccountB64: env.FIREBASE_SERVICE_ACCOUNT_B64,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
	console.log(`minha-agenda-api em :${info.port} (${env.NODE_ENV})`);
});

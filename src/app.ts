/**
 * App Hono principal — monta rotas + middleware.
 * index.ts (entrypoint) só cuida do serve() e do env.
 */
import { Hono } from "hono";
import { firebaseAuthMiddleware } from "./middleware/auth.js";
import { appointmentRoutes } from "./routes/appointments.js";
import { authSyncRoutes } from "./routes/auth-sync.js";
import type { AppEnv } from "./types.js";

export function createApp(opts: {
	databaseUrl: string;
	firebaseProjectId: string;
	firebaseServiceAccountB64?: string;
}) {
	const app = new Hono<AppEnv>();

	app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

	// Tudo abaixo exige ID token Firebase válido
	app.use(
		"/v1/*",
		firebaseAuthMiddleware(
			opts.firebaseProjectId,
			opts.firebaseServiceAccountB64,
		),
	);
	app.route("/v1", authSyncRoutes(opts.databaseUrl));
	app.route("/v1/appointments", appointmentRoutes(opts.databaseUrl));

	return app;
}

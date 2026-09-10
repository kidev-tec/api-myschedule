/**
 * App Hono principal — monta rotas + middleware.
 * index.ts (entrypoint) só cuida do serve() e do env.
 */

import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { firebaseAuthMiddleware } from "./middleware/auth.js";
import { requireWritableFactory } from "./middleware/paywall.js";
import { appointmentRoutes } from "./routes/appointments.js";
import { authSyncRoutes } from "./routes/auth-sync.js";
import { clientsRoutes } from "./routes/clients.js";
import { gcalRoutes } from "./routes/gcal.js";
import { publicBookingRoutes } from "./routes/public-booking.js";
import { meRoutes, servicesRoutes } from "./routes/services.js";
import { versionRoutes } from "./routes/version.js";
import { workingHoursRoutes } from "./routes/working-hours.js";
import type { AppEnv } from "./types.js";

export function createApp(opts: {
	databaseUrl: string;
	firebaseProjectId: string;
	firebaseServiceAccountB64?: string;
}) {
	const app = new Hono<AppEnv>();

	app.get("/health", (c) => c.json({ ok: true, ts: new Date().toISOString() }));

	// Tudo abaixo exige ID token Firebase válido, EXCETO o callback do
	// Google Calendar (Google chama sem ID token; a chamada é autenticada
	// pelo state=uid e o código de autorização de uso único).
	const publicPaths = ["/v1/gcal/callback"];
	app.use("/v1/*", async (c, next) => {
		if (publicPaths.some((p) => c.req.path.startsWith(p))) {
			return next();
		}
		return firebaseAuthMiddleware(
			opts.firebaseProjectId,
			opts.firebaseServiceAccountB64,
		)(c as never, next);
	});

	// Paywall (RF-14): trial vencido/canceled → 402 em tudo que escreve.
	// GET /me, /services, /clients etc. continuam abertos (leitura livre);
	// auth-sync é idempotente e precisa sempre passar.
	const requireWritable = requireWritableFactory(opts.databaseUrl);
	// gcal/callback é público por natureza (Google chama sem ID token);
	// autenticação da chamada vem pelo parâmetro state (uid do business).
	const readOnlyPaths = ["/v1/auth/sync", "/v1/gcal/callback"];
	app.use("/v1/*", async (c, next) => {
		if (
			c.req.method === "GET" ||
			readOnlyPaths.some((p) => c.req.path.startsWith(p))
		) {
			return next();
		}
		return requireWritable(c, next);
	});

	app.route("/v1", authSyncRoutes(opts.databaseUrl));
	app.route("/v1", meRoutes(opts.databaseUrl));
	app.route("/v1", servicesRoutes(opts.databaseUrl));
	app.route("/v1", workingHoursRoutes(opts.databaseUrl));
	app.route("/v1", clientsRoutes(opts.databaseUrl));
	app.route("/v1/appointments", appointmentRoutes(opts.databaseUrl));

	// RF-07 — link público (sem Firebase auth; rotas /p/*)
	app.route("/", publicBookingRoutes(opts.databaseUrl));

	// Updater — versão do app + download do APK (sem auth)
	app.route("/", versionRoutes());

	// RF-08 — Google Calendar (authed; callback é público por natureza)
	app.route("/v1", gcalRoutes(opts.databaseUrl));
	app.use(
		"/apks/*",
		serveStatic({
			root: "./public/apks",
			rewriteRequestPath: (p) => p.replace(/^\/apks/, ""),
		}),
	);

	return app;
}

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
import { asaasWebhookRoutes } from "./routes/asaas-webhook.js";
import { billingRoutes } from "./routes/billing.js";
import { docsRoutes } from "./routes/docs.js";
import { gcalRoutes } from "./routes/gcal.js";
import {
	deviceRoutes,
	internalRoutes,
	logoRoutes,
} from "./routes/infrastructure.js";
import { schoolRoutes } from "./routes/school.js";
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
	// pelo state=uid e o código de autorização de uso único), a logo
	// pública (o link de agendamento carrega a imagem sem conta) e a
	// confirmação do cliente (RF-B02: token HMAC no link do WhatsApp).
	const publicPaths = [
		"/v1/gcal/callback",
		"/v1/businesses/",
		"/v1/internal/",
		"/v1/p/",
	];
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
	const readOnlyPaths = [
		"/v1/auth/sync",
		"/v1/gcal/callback",
		"/v1/businesses/",
		"/v1/internal/",
	];
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
	app.route("/v1", deviceRoutes(opts.databaseUrl));
	app.route("/v1", workingHoursRoutes(opts.databaseUrl));
	app.route("/v1", clientsRoutes(opts.databaseUrl));
	app.route("/v1/appointments", appointmentRoutes(opts.databaseUrl));

	// Logo pública (sem auth — o link de agendamento usa) + rotas internas
	app.route("/v1", logoRoutes(opts.databaseUrl));
	app.route("/v1", internalRoutes(opts.databaseUrl));
	app.route("/v1", schoolRoutes(opts.databaseUrl));

	// Billing Asaas (RF-14) — checkout authed + writable (paywall naturalmente
	// deixa trial ativo passar; a rota é de ESCRITA no banco por natureza)
	app.route("/v1", billingRoutes(opts.databaseUrl));

	// Webhook do Asaas — público (Asaas não tem Firebase), raiz fora do /v1.
	// Autenticado pelo header asaas-access-token (não pelo middleware Firebase).
	app.route("/", asaasWebhookRoutes(opts.databaseUrl));

	// RF-07 — link público (sem Firebase auth; rotas /p/*)
	app.route("/", publicBookingRoutes(opts.databaseUrl));

	// Updater — versão do app + download do APK (sem auth)
	app.route("/", versionRoutes());

	// RF-08 — Google Calendar (authed; callback é público por natureza)
	app.route("/v1", gcalRoutes(opts.databaseUrl));

	// Docs — OpenAPI 3.1 + Scalar UI (público)
	app.route("/", docsRoutes());
	app.use(
		"/apks/*",
		serveStatic({
			root: "./public/apks",
			rewriteRequestPath: (p) => p.replace(/^\/apks/, ""),
		}),
	);

	return app;
}

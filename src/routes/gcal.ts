/**
 * RF-08 — Google Calendar (OAuth 2 toques).
 *
 * Fluxo (client OAuth tipo "installed", sem backend secret exposure):
 * 1. GET  /v1/gcal/auth-url  (authed) → { url } consent screen
 * 2. Google → GET /v1/gcal/callback?code=...&state=<firebaseUid>
 *    → troca code por tokens → salva refresh_token no business
 *    → HTML "autorizado, volte ao app"
 * 3. Espelho: todo agendamento confirmado ganha evento no Calendar
 *    (POST /v1/gcal/disconnect remove)
 *
 * state=firebaseUid liga o callback ao usuário (CSRF mínimo ok pro MVP:
 * uid só é aceito se o business existir).
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/connection.js";
import { businesses, users } from "../db/schema.js";
import { encryptToken } from "../domain/token-crypto.js";
import type { AppEnv } from "../types.js";

const GCAL_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GCAL_TOKEN = "https://oauth2.googleapis.com/token";
const GCAL_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function env(name: string): string {
	return process.env[name] ?? "";
}

function redirectUri(): string {
	// redirect_uris do client "installed": loopback. Em dev: porta da API.
	return env("GCAL_REDIRECT_URI") || "http://localhost:3200/v1/gcal/callback";
}

export function gcalRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	// 1) URL de consentimento (authed)
	routes.get("/gcal/auth-url", (c) => {
		const uid = c.get("authUser").uid;
		const url = new URL(GCAL_AUTH);
		url.searchParams.set("client_id", env("GCAL_CLIENT_ID"));
		url.searchParams.set("redirect_uri", redirectUri());
		url.searchParams.set("response_type", "code");
		url.searchParams.set("scope", GCAL_SCOPE);
		url.searchParams.set("access_type", "offline"); // refresh_token
		url.searchParams.set("prompt", "consent"); // garante refresh_token
		url.searchParams.set("state", uid);
		return c.json({ url: url.toString() });
	});

	// 2) callback do Google (sem auth — o state carrega o uid)
	routes.get("/gcal/callback", async (c) => {
		const code = c.req.query("code");
		const uid = c.req.query("state");
		if (!code || !uid) {
			return c.html("<h1>Faltou código de autorização</h1>", 400);
		}

		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.html("<h1>Usuário não encontrado</h1>", 404);

		const tokenRes = await fetch(GCAL_TOKEN, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: env("GCAL_CLIENT_ID"),
				client_secret: env("GCAL_CLIENT_SECRET"),
				redirect_uri: redirectUri(),
				grant_type: "authorization_code",
			}),
		});
		if (!tokenRes.ok) {
			return c.html("<h1>Google recusou a autorização</h1>", 502);
		}
		const tokens = (await tokenRes.json()) as {
			refresh_token?: string;
		};
		if (!tokens.refresh_token) {
			return c.html(
				"<h1>Sem permissão permanente</h1><p>Autorize novamente aceitando 'manter conectado'.</p>",
				400,
			);
		}

		await db
			.update(businesses)
			.set({
				// B9: refresh_token cifrado em repouso (AES-256-GCM)
				gcalRefreshToken: encryptToken(tokens.refresh_token),
				gcalConnectedAt: new Date(),
			})
			.where(eq(businesses.id, me.businessId));

		return c.html(
			'<div style="font-family:system-ui;text-align:center;padding:40px">' +
				"<h1>✅ Google Calendar conectado!</h1>" +
				"<p>Volte ao app Minha Agenda — os agendamentos confirmados vão aparecer no teu Calendar.</p>" +
				"</div>",
		);
	});

	// 3) status + disconnect (authed)
	routes.get("/gcal/status", async (c) => {
		const uid = c.get("authUser").uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const biz = (
			await db
				.select({ gcal: businesses.gcalConnectedAt })
				.from(businesses)
				.where(eq(businesses.id, me.businessId))
				.limit(1)
		)[0];
		return c.json({ connected: Boolean(biz?.gcal) });
	});

	routes.delete("/gcal", async (c) => {
		const uid = c.get("authUser").uid;
		const me = (
			await db.select().from(users).where(eq(users.firebaseUid, uid)).limit(1)
		)[0];
		/* v8 ignore next -- inatingível: paywall/404 pega ghost antes */
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		await db
			.update(businesses)
			.set({ gcalRefreshToken: null, gcalConnectedAt: null })
			.where(eq(businesses.id, me.businessId));
		return c.json({ ok: true });
	});

	return routes;
}

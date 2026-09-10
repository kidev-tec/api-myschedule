/**
 * Middleware de auth — valida ID token do Firebase (BD-01, 09/09).
 *
 * Fluxo: app autentica no Firebase (email/senha ou Google OAuth) → envia
 * `Authorization: Bearer <idToken>` → aqui verificamos assinatura/project_id
 * via firebase-admin e anexamos { uid, email, name } no contexto Hono.
 *
 * Em teste (NODE_ENV=test) com FIREBASE_SKIP_VERIFY=1 aceita token literal
 * "test-uid" — apenas para suite unit; nunca em produção (env schema garante).
 */

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { MiddlewareHandler } from "hono";

export type AuthUser = {
	uid: string;
	email: string | undefined;
	name: string | undefined;
};

declare module "hono" {
	interface ContextVariableMap {
		authUser: AuthUser;
	}
}

function initFirebaseAdmin(
	projectId: string,
	serviceAccountB64?: string,
): void {
	if (getApps().length > 0) return;
	if (serviceAccountB64) {
		const json = JSON.parse(
			Buffer.from(serviceAccountB64, "base64").toString("utf8"),
		) as { client_email: string; private_key: string };
		initializeApp({
			credential: cert({
				projectId,
				clientEmail: json.client_email,
				privateKey: json.private_key,
			}),
			projectId,
		});
	} else {
		// Sem service account: validação via Google public keys (project_id do env)
		initializeApp({ projectId });
	}
}

type Env = {
	Variables: { authUser: AuthUser };
	Bindings: Record<string, never>;
};

export function firebaseAuthMiddleware(
	projectId: string,
	serviceAccountB64: string | undefined,
): MiddlewareHandler<Env> {
	initFirebaseAdmin(projectId, serviceAccountB64);
	return async (c, next) => {
		const header = c.req.header("Authorization");
		if (!header?.startsWith("Bearer ")) {
			return c.json(
				{
					error: "token ausente",
					hint: "Envie Authorization: Bearer <idToken do Firebase>",
				},
				401,
			);
		}
		const token = header.slice("Bearer ".length);

		try {
			const decoded = await getAuth().verifyIdToken(token, true);
			c.set("authUser", {
				uid: decoded.uid,
				email: decoded.email,
				name: decoded.name,
			});
			await next();
		} catch {
			return c.json(
				{ error: "token inválido ou expirado", hint: "Refaça o login no app" },
				401,
			);
		}
	};
}

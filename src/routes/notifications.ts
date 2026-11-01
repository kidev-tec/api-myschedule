/**
 * 0024 — central de notificações do prestador (sino do app).
 *
 * - GET  /notifications?before=ISO&limit=N → { notifications, unread }
 *        (mais novas primeiro; `before` pagina pelas mais antigas)
 * - GET  /notifications/unread-count → { unread } (badge do sino)
 * - POST /notifications/:id/read     → marca uma como lida
 * - POST /notifications/read-all     → marca todas como lidas
 *
 * Quem cria é services/notify.ts (todo push pro prestador passa por lá).
 */
import { and, count, desc, eq, isNull, lt } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/connection.js";
import { notifications, users } from "../db/schema.js";
import type { AppEnv } from "../types.js";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_DEFAULT = 30;
const PAGE_MAX = 100;

export function notificationRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();

	async function meId(uid: string): Promise<string | null> {
		const [me] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.firebaseUid, uid))
			.limit(1);
		return me?.id ?? null;
	}

	async function unreadOf(userId: string): Promise<number> {
		const [r] = await db
			.select({ n: count() })
			.from(notifications)
			.where(
				and(eq(notifications.userId, userId), isNull(notifications.readAt)),
			);
		/* v8 ignore next -- count() sempre devolve 1 linha */
		return r?.n ?? 0;
	}

	routes.get("/notifications/unread-count", async (c) => {
		const me = await meId(c.get("authUser").uid);
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		return c.json({ unread: await unreadOf(me) });
	});

	routes.get("/notifications", async (c) => {
		const me = await meId(c.get("authUser").uid);
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const limitRaw = Number(c.req.query("limit") ?? PAGE_DEFAULT);
		const limit =
			Number.isInteger(limitRaw) && limitRaw > 0
				? Math.min(limitRaw, PAGE_MAX)
				: PAGE_DEFAULT;
		const beforeRaw = c.req.query("before");
		const before = beforeRaw ? new Date(beforeRaw) : null;
		if (before && Number.isNaN(before.getTime())) {
			return c.json({ error: "before inválido (ISO 8601)" }, 400);
		}
		const rows = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, me),
					...(before ? [lt(notifications.createdAt, before)] : []),
				),
			)
			.orderBy(desc(notifications.createdAt))
			.limit(limit);
		return c.json({
			notifications: rows.map((n) => ({
				id: n.id,
				type: n.type,
				title: n.title,
				body: n.body,
				data: n.data ?? {},
				read: n.readAt !== null,
				created_at: n.createdAt.toISOString(),
			})),
			unread: await unreadOf(me),
		});
	});

	routes.post("/notifications/read-all", async (c) => {
		const me = await meId(c.get("authUser").uid);
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		await db
			.update(notifications)
			.set({ readAt: new Date() })
			.where(and(eq(notifications.userId, me), isNull(notifications.readAt)));
		return c.json({ unread: 0 });
	});

	routes.post("/notifications/:id/read", async (c) => {
		const me = await meId(c.get("authUser").uid);
		if (!me) return c.json({ error: "user não encontrado" }, 404);
		const id = c.req.param("id");
		if (!UUID_RE.test(id)) return c.json({ error: "id inválido" }, 400);
		const [row] = await db
			.update(notifications)
			.set({ readAt: new Date() })
			.where(and(eq(notifications.id, id), eq(notifications.userId, me)))
			.returning({ id: notifications.id });
		if (!row) return c.json({ error: "notificação não encontrada" }, 404);
		return c.json({ ok: true, unread: await unreadOf(me) });
	});

	return routes;
}

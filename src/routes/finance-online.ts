/**
 * Módulo de finanças — Fase 5: recebimento online (Asaas, subcontas)
 * (.planning/financas/SPEC-F5-CHECKOUT.md; RF-F13).
 *
 * - GET  /finance/online/account  — disponível? situação da subconta
 * - POST /finance/online/account  — ativa (cria a subconta do negócio)
 * - POST /finance/charges         — cobrança por link de um agendamento
 * - GET  /finance/charges?appointment_id=
 * - DELETE /finance/charges/:id   — cancela cobrança pendente
 *
 * Recurso desligado (env incompleta) → 503. A chave da subconta só existe
 * cifrada no banco; nunca aparece em resposta ou log.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type Db, getDb } from "../db/connection.js";
import { paidCentsOf } from "../db/finance-queries.js";
import {
	appointments,
	businesses,
	charges,
	clients,
	services,
	users,
} from "../db/schema.js";
import { formatBRL, MAX_CENTS } from "../domain/payment-status.js";
import { dayKey } from "../domain/schedule-day.js";
import { decryptWith, encryptWith } from "../domain/token-crypto.js";
import {
	AsaasError,
	cancelCharge,
	createCharge,
	createSubaccount,
	ensureCustomer,
	loadSubaccountConfig,
	type SubaccountConfig,
	subaccountStatus,
} from "../services/asaas-subaccounts.js";
import type { AppEnv } from "../types.js";
import {
	firstIssue,
	HttpError,
	requireUser,
	uuidSchema,
} from "./finance-shared.js";

const UNAVAILABLE = "Recebimento online ainda não está disponível";

const digits = (v: string) => v.replace(/\D/g, "");
const localDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida (use AAAA-MM-DD)");

export const COMPANY_TYPES = [
	"MEI",
	"LIMITED",
	"INDIVIDUAL",
	"ASSOCIATION",
] as const;

export const activateSchema = z
	.object({
		name: z.string().trim().min(2, "Informe o nome").max(120).optional(),
		cpf_cnpj: z
			.string("Informe o CPF ou CNPJ")
			.transform(digits)
			.refine(
				(v) => v.length === 11 || v.length === 14,
				"CPF ou CNPJ inválido",
			),
		birth_date: localDate.optional(),
		company_type: z.enum(COMPANY_TYPES, "Tipo de empresa inválido").optional(),
		mobile_phone: z
			.string("Informe o celular")
			.transform(digits)
			.refine((v) => v.length === 10 || v.length === 11, "Celular inválido"),
		income_cents: z
			.int("Faturamento mensal inválido")
			.min(1, "Faturamento mensal inválido")
			.max(MAX_CENTS, "Faturamento mensal inválido"),
		postal_code: z
			.string("Informe o CEP")
			.transform(digits)
			.refine((v) => v.length === 8, "CEP inválido"),
		address: z.string("Informe a rua").trim().min(2, "Informe a rua").max(200),
		address_number: z
			.string("Informe o número")
			.trim()
			.min(1, "Informe o número")
			.max(20),
		complement: z.string().trim().max(80).optional(),
		province: z
			.string("Informe o bairro")
			.trim()
			.min(2, "Informe o bairro")
			.max(80),
	})
	.superRefine((b, ctx) => {
		if (b.cpf_cnpj.length === 11 && !b.birth_date) {
			ctx.addIssue({ code: "custom", message: "Informe a data de nascimento" });
		}
		if (b.cpf_cnpj.length === 14 && !b.company_type) {
			ctx.addIssue({ code: "custom", message: "Informe o tipo de empresa" });
		}
	});

export const chargeCreateSchema = z.object({
	appointment_id: z.uuid("Registro inválido"),
	amount_cents: z
		.int("Valor inválido")
		.min(500, "Valor mínimo para cobrar pelo link: R$ 5,00")
		.max(MAX_CENTS, "Valor inválido")
		.optional(),
	due_date: localDate.optional(),
});

/** Situação geral do Asaas → nossa situação. */
export function mapAccountStatus(
	general: string,
): "approved" | "rejected" | "pending" {
	if (general === "APPROVED") return "approved";
	if (general === "REJECTED") return "rejected";
	return "pending";
}

type Biz = typeof businesses.$inferSelect;

function chargeJson(ch: typeof charges.$inferSelect) {
	return {
		id: ch.id,
		appointment_id: ch.appointmentId,
		amount_cents: ch.amountCents,
		status: ch.status,
		invoice_url: ch.invoiceUrl,
		due_date: ch.dueDate,
		created_at: ch.createdAt,
	};
}

/** Erro do Asaas → resposta: validação (400) vira 422 com a mensagem dele. */
function asaasHttp(err: AsaasError): { status: 422 | 502; error: string } {
	return err.status === 400
		? { status: 422, error: err.message }
		: {
				status: 502,
				error: `O Asaas não respondeu como esperado: ${err.message}`,
			};
}

export function financeOnlineRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono<AppEnv>();
	const config = () => loadSubaccountConfig(process.env);

	async function business(db: Pick<Db, "select">, id: string) {
		const [b] = await db
			.select()
			.from(businesses)
			.where(eq(businesses.id, id))
			.limit(1);
		/* v8 ignore next -- business do usuário sempre existe (FK) */
		if (!b) throw new Error("negócio desapareceu");
		return b;
	}

	const subKey = (cfg: SubaccountConfig, b: Biz) =>
		decryptWith(cfg.encKey, b.asaasSubApiKeyEnc as string);

	routes.get("/finance/online/account", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const cfg = config();
		const b = await business(db, user.businessId);
		let status = b.asaasSubStatus;
		if (cfg && status === "pending" && b.asaasSubApiKeyEnc) {
			try {
				const fresh = mapAccountStatus(
					await subaccountStatus(cfg, subKey(cfg, b)),
				);
				if (fresh !== status) {
					status = fresh;
					await db
						.update(businesses)
						.set({ asaasSubStatus: fresh, asaasSubUpdatedAt: new Date() })
						.where(eq(businesses.id, b.id));
				}
			} catch (err) {
				// consulta é melhor-esforço: mantém a situação gravada
				console.warn(
					"[online] status da subconta indisponível:",
					(err as Error).message,
				);
			}
		}
		return c.json({ available: cfg !== null, status });
	});

	routes.post("/finance/online/account", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const cfg = config();
		if (!cfg) return c.json({ error: UNAVAILABLE }, 503);
		const raw = await c.req.json().catch(() => undefined);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = activateSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const d = parsed.data;
		try {
			await db.transaction(async (tx) => {
				// trava o negócio: duas ativações simultâneas criam 1 subconta
				const [b] = await tx
					.select()
					.from(businesses)
					.where(eq(businesses.id, user.businessId))
					.for("update");
				/* v8 ignore next -- business do usuário sempre existe (FK) */
				if (!b) throw new Error("negócio desapareceu");
				if (b.asaasSubAccountId) {
					throw new HttpError(409, "O recebimento online já foi ativado");
				}
				const [u] = await tx
					.select({ email: users.email, name: users.name })
					.from(users)
					.where(eq(users.id, user.id));
				/* v8 ignore next -- usuário existe (requireUser) */
				if (!u) throw new Error("usuário desapareceu");
				const sub = await createSubaccount(cfg, b.id, {
					name: d.name ?? u.name,
					email: u.email,
					cpfCnpj: d.cpf_cnpj,
					...(d.cpf_cnpj.length === 11
						? { birthDate: d.birth_date }
						: { companyType: d.company_type }),
					mobilePhone: d.mobile_phone,
					incomeValue: d.income_cents / 100,
					postalCode: d.postal_code,
					address: d.address,
					addressNumber: d.address_number,
					complement: d.complement,
					province: d.province,
				});
				await tx
					.update(businesses)
					.set({
						asaasSubAccountId: sub.id,
						asaasSubWalletId: sub.walletId,
						asaasSubApiKeyEnc: encryptWith(cfg.encKey, sub.apiKey),
						asaasSubStatus: "pending",
						asaasSubUpdatedAt: new Date(),
					})
					.where(eq(businesses.id, b.id));
			});
			return c.json({ available: true, status: "pending" }, 201);
		} catch (err) {
			if (err instanceof HttpError) {
				return c.json({ error: err.message }, err.status);
			}
			/* v8 ignore next -- falha inesperada do banco: handler global (500) */
			if (!(err instanceof AsaasError)) throw err;
			const h = asaasHttp(err);
			return c.json({ error: h.error }, h.status);
		}
	});

	routes.post("/finance/charges", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const cfg = config();
		if (!cfg) return c.json({ error: UNAVAILABLE }, 503);
		const raw = await c.req.json().catch(() => undefined);
		if (raw === undefined) return c.json({ error: "Dados inválidos" }, 400);
		const parsed = chargeCreateSchema.safeParse(raw);
		if (!parsed.success) {
			return c.json({ error: firstIssue(parsed.error) }, 400);
		}
		const body = parsed.data;
		const b = await business(db, user.businessId);
		if (b.asaasSubStatus !== "approved") {
			return c.json(
				{
					error:
						b.asaasSubStatus === "none"
							? "Ative o recebimento online primeiro"
							: "Seu recebimento online ainda não foi aprovado pelo Asaas",
				},
				409,
			);
		}
		try {
			const charge = await db.transaction(async (tx) => {
				const [a] = await tx
					.select({
						id: appointments.id,
						startsAt: appointments.startsAt,
						status: appointments.status,
						priceCents: appointments.priceCents,
						clientId: appointments.clientId,
						clientName: clients.name,
						clientCpf: clients.cpf,
						service: services.name,
					})
					.from(appointments)
					.innerJoin(clients, eq(clients.id, appointments.clientId))
					.innerJoin(services, eq(services.id, appointments.serviceId))
					.where(
						and(
							eq(appointments.id, body.appointment_id),
							eq(appointments.businessId, user.businessId),
						),
					)
					.for("update", { of: appointments });
				if (!a) throw new HttpError(404, "Agendamento não encontrado");
				if (a.status === "canceled") {
					throw new HttpError(
						422,
						"Agendamento cancelado não pode ser cobrado",
					);
				}
				if (!a.clientCpf) {
					throw new HttpError(
						422,
						"Cadastre o CPF do cliente para cobrar online",
					);
				}
				const [pending] = await tx
					.select({
						total: sql<number>`COALESCE(sum(${charges.amountCents}), 0)::int`,
					})
					.from(charges)
					.where(
						and(
							eq(charges.appointmentId, a.id),
							inArray(charges.status, ["pending", "overdue"]),
						),
					);
				/* v8 ignore next -- agregado sempre devolve 1 linha */
				const pendingCents = pending?.total ?? 0;
				const open =
					a.priceCents - (await paidCentsOf(tx, a.id)) - pendingCents;
				if (open <= 0) {
					throw new HttpError(
						422,
						pendingCents > 0
							? "Já existe cobrança em aberto para todo o saldo deste agendamento"
							: "Este agendamento não tem saldo a cobrar",
					);
				}
				const amount = body.amount_cents ?? open;
				if (amount > open) {
					throw new HttpError(
						422,
						`Valor maior que o saldo a cobrar (${formatBRL(open)})`,
					);
				}
				const tz = b.timezone;
				const today = dayKey(new Date(), tz);
				const apptDay = dayKey(a.startsAt, tz);
				const due = body.due_date ?? (apptDay > today ? apptDay : today);
				if (due < today) {
					throw new HttpError(422, "O vencimento não pode ser no passado");
				}
				const key = subKey(cfg, b);
				const customer = await ensureCustomer(cfg, key, {
					name: a.clientName,
					cpfCnpj: a.clientCpf,
					externalReference: a.clientId,
				});
				const asaas = await createCharge(cfg, key, {
					customer,
					valueCents: amount,
					dueDate: due,
					description: `${a.service} — ${apptDay.split("-").reverse().join("/")}`,
					externalReference: a.id,
				});
				const [created] = await tx
					.insert(charges)
					.values({
						businessId: user.businessId,
						appointmentId: a.id,
						asaasPaymentId: asaas.id,
						amountCents: amount,
						invoiceUrl: asaas.invoiceUrl,
						dueDate: due,
						createdBy: user.id,
					})
					.returning();
				/* v8 ignore next -- INSERT..RETURNING nunca é vazio */
				if (!created) throw new Error("falha ao registrar cobrança");
				return created;
			});
			return c.json({ charge: chargeJson(charge) }, 201);
		} catch (err) {
			if (err instanceof HttpError) {
				return c.json({ error: err.message }, err.status);
			}
			/* v8 ignore next -- falha inesperada do banco: handler global (500) */
			if (!(err instanceof AsaasError)) throw err;
			const h = asaasHttp(err);
			return c.json({ error: h.error }, h.status);
		}
	});

	routes.get("/finance/charges", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const id = c.req.query("appointment_id") ?? "";
		if (!uuidSchema.safeParse(id).success) {
			return c.json({ error: "Registro inválido" }, 400);
		}
		const rows = await db
			.select()
			.from(charges)
			.where(
				and(
					eq(charges.appointmentId, id),
					eq(charges.businessId, user.businessId),
				),
			)
			.orderBy(asc(charges.createdAt));
		return c.json({ charges: rows.map(chargeJson) });
	});

	routes.delete("/finance/charges/:id", async (c) => {
		const user = await requireUser(db, c.get("authUser").uid);
		/* v8 ignore next -- inatingível: paywall/auth retornam antes */
		if (!user) return c.json({ error: "usuário não sincronizado" }, 403);
		const cfg = config();
		if (!cfg) return c.json({ error: UNAVAILABLE }, 503);
		const id = c.req.param("id");
		if (!uuidSchema.safeParse(id).success) {
			return c.json({ error: "Registro inválido" }, 400);
		}
		const [ch] = await db
			.select()
			.from(charges)
			.where(and(eq(charges.id, id), eq(charges.businessId, user.businessId)))
			.limit(1);
		if (!ch) return c.json({ error: "Cobrança não encontrada" }, 404);
		if (ch.status !== "pending" && ch.status !== "overdue") {
			return c.json({ error: "Só dá para cancelar cobrança em aberto" }, 409);
		}
		const b = await business(db, user.businessId);
		try {
			await cancelCharge(cfg, subKey(cfg, b), ch.asaasPaymentId);
		} catch (err) {
			/* v8 ignore next -- falha inesperada: handler global (500) */
			if (!(err instanceof AsaasError)) throw err;
			const h = asaasHttp(err);
			return c.json({ error: h.error }, h.status);
		}
		const [updated] = await db
			.update(charges)
			.set({ status: "canceled", updatedAt: new Date() })
			.where(eq(charges.id, ch.id))
			.returning();
		/* v8 ignore next -- UPDATE..RETURNING na linha encontrada */
		if (!updated) throw new Error("cobrança desapareceu");
		return c.json({ charge: chargeJson(updated) });
	});

	return routes;
}

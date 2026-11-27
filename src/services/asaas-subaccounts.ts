/**
 * Asaas — subcontas dos profissionais (módulo de finanças F5,
 * .planning/financas/SPEC-F5-CHECKOUT.md). ÚNICA porta para o Asaas no
 * recebimento online: se o contrato do Asaas mudar, muda só aqui.
 *
 * - A conta raiz (PJ, ASAAS_SUBACCOUNTS_API_KEY) só cria subcontas.
 * - Clientes e cobranças são feitos com a chave DA SUBCONTA (o dinheiro cai
 *   na conta do profissional; o Agenva não intermedia valores).
 * - Nenhuma chave aparece em erro/log.
 */

export type SubaccountConfig = {
	baseUrl: string;
	rootKey: string;
	encKey: string;
	webhookToken: string;
	webhookUrl: string;
};

/** Config do recebimento online; null = recurso desligado/incompleto. */
export function loadSubaccountConfig(
	env: Record<string, string | undefined>,
): SubaccountConfig | null {
	const v = (k: string) => env[k]?.trim() || "";
	if (v("ASAAS_SUBACCOUNTS_ENABLED") !== "1") return null;
	const cfg = {
		baseUrl: (v("ASAAS_BASE_URL") || "https://api-sandbox.asaas.com")
			.replace(/\/$/, "")
			.replace(/\/v3$/, ""),
		rootKey: v("ASAAS_SUBACCOUNTS_API_KEY"),
		encKey: v("ASAAS_SUBACCOUNT_ENC_KEY"),
		webhookToken: v("ASAAS_SUBACCOUNT_WEBHOOK_TOKEN"),
		webhookUrl: v("ASAAS_SUBACCOUNT_WEBHOOK_URL").replace(/\/$/, ""),
	};
	return Object.values(cfg).every((x) => x !== "") ? cfg : null;
}

/** Erro do Asaas com a mensagem (PT-BR) que ele devolve — sem dados sensíveis. */
export class AsaasError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(
	cfg: SubaccountConfig,
	key: string,
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown,
): Promise<T> {
	const resp = await fetch(`${cfg.baseUrl}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "agenva-api",
			access_token: key,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await resp.json().catch(() => null)) as {
		errors?: { description?: string }[];
		message?: string;
	} | null;
	if (!resp.ok) {
		const msg =
			data?.errors?.[0]?.description ??
			data?.message ??
			"Não foi possível falar com o Asaas agora. Tente de novo.";
		throw new AsaasError(resp.status, msg);
	}
	return data as T;
}

/** Eventos assinados no webhook de cada subconta. */
export const SUBACCOUNT_EVENTS = [
	"PAYMENT_CONFIRMED",
	"PAYMENT_RECEIVED",
	"PAYMENT_OVERDUE",
	"PAYMENT_DELETED",
	"PAYMENT_REFUNDED",
	"ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED",
	"ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED",
	"ACCOUNT_STATUS_GENERAL_APPROVAL_PENDING",
] as const;

export type NewSubaccount = {
	name: string;
	email: string;
	cpfCnpj: string;
	birthDate?: string;
	companyType?: string;
	mobilePhone: string;
	incomeValue: number;
	postalCode: string;
	address: string;
	addressNumber: string;
	complement?: string;
	province: string;
};

export async function createSubaccount(
	cfg: SubaccountConfig,
	businessId: string,
	data: NewSubaccount,
) {
	const r = await call<{ id: string; walletId: string; apiKey: string }>(
		cfg,
		cfg.rootKey,
		"POST",
		"/v3/accounts",
		{
			...data,
			webhooks: [
				{
					name: "Agenva",
					url: `${cfg.webhookUrl}/webhooks/asaas/subaccounts/${businessId}`,
					email: data.email,
					sendType: "SEQUENTIALLY",
					interrupted: false,
					enabled: true,
					apiVersion: 3,
					authToken: cfg.webhookToken,
					events: SUBACCOUNT_EVENTS,
				},
			],
		},
	);
	return { id: r.id, walletId: r.walletId, apiKey: r.apiKey };
}

/** Situação geral da subconta: APPROVED | REJECTED | PENDING | AWAITING_… */
export async function subaccountStatus(cfg: SubaccountConfig, subKey: string) {
	const r = await call<{ general?: string }>(
		cfg,
		subKey,
		"GET",
		"/v3/myAccount/status",
	);
	return r.general ?? "PENDING";
}

/** Cliente da subconta pelo externalReference (cria se não existir). */
export async function ensureCustomer(
	cfg: SubaccountConfig,
	subKey: string,
	c: { name: string; cpfCnpj: string; externalReference: string },
) {
	const found = await call<{ data?: { id: string }[] }>(
		cfg,
		subKey,
		"GET",
		`/v3/customers?externalReference=${encodeURIComponent(c.externalReference)}`,
	);
	const existing = found.data?.[0]?.id;
	if (existing) return existing;
	const r = await call<{ id: string }>(cfg, subKey, "POST", "/v3/customers", c);
	return r.id;
}

/** Cobrança em que o cliente escolhe a forma (Pix, cartão ou boleto). */
export async function createCharge(
	cfg: SubaccountConfig,
	subKey: string,
	p: {
		customer: string;
		valueCents: number;
		dueDate: string;
		description: string;
		externalReference: string;
	},
) {
	const r = await call<{ id: string; invoiceUrl?: string; status?: string }>(
		cfg,
		subKey,
		"POST",
		"/v3/payments",
		{
			customer: p.customer,
			billingType: "UNDEFINED",
			value: p.valueCents / 100,
			dueDate: p.dueDate,
			description: p.description,
			externalReference: p.externalReference,
		},
	);
	return { id: r.id, invoiceUrl: r.invoiceUrl ?? null };
}

export async function cancelCharge(
	cfg: SubaccountConfig,
	subKey: string,
	paymentId: string,
) {
	await call(cfg, subKey, "DELETE", `/v3/payments/${paymentId}`);
}

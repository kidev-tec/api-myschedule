/**
 * Service Asaas (billing, RF-14 — SPEC .planning/billing-asaas/SPEC.md).
 *
 * O app NUNCA fala com o Asaas direto: a chave fica no .env do servidor.
 * Sandbox em desenvolvimento (ASAAS_BASE_URL), produção troca só env.
 * Sem ASAAS_API_KEY no ambiente → configured=false → rota de checkout
 * responde 503 fail-closed (mesma filosofia do trial-reminders).
 *
 * Testes SEMPRE mockam o fetch — nunca chamam o sandbox real.
 */

const ASASA_DEFAULT_BASE_URL = "https://api-sandbox.asaas.com";

export type AsaasConfig = {
	apiKey: string;
	baseUrl: string;
	planValueCents: number;
};

export type AsaasCustomer = { id: string };
export type AsaasSubscription = { id: string; invoiceUrl?: string };

/** Lê a config do ambiente; null quando não há chave (fail-closed na rota). */
export function loadAsaasConfig(
	env: Record<string, string | undefined>,
): AsaasConfig | null {
	const apiKey = env.ASAAS_API_KEY;
	if (!apiKey || apiKey.trim() === "") return null;
	const cents = Number(env.ASAAS_PLAN_VALUE ?? "");
	return {
		apiKey,
		baseUrl: (env.ASAAS_BASE_URL ?? ASASA_DEFAULT_BASE_URL).replace(/\/$/, ""),
		planValueCents: Number.isInteger(cents) && cents > 0 ? cents : 0,
	};
}

async function asaasFetch<T>(
	config: AsaasConfig,
	path: string,
	body: unknown,
): Promise<T> {
	const resp = await fetch(`${config.baseUrl}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			access_token: config.apiKey,
		},
		body: JSON.stringify(body),
	});
	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`Asaas ${resp.status}: ${detail.slice(0, 200)}`);
	}
	return (await resp.json()) as T;
}

/** Cria (ou recupera por cpfCnpj/externalReference) o customer no Asaas. */
export function createCustomer(
	config: AsaasConfig,
	input: { name: string; email: string; externalReference: string },
): Promise<AsaasCustomer> {
	return asaasFetch<AsaasCustomer>(config, "/v3/customers", {
		name: input.name,
		email: input.email,
		externalReference: input.externalReference,
	});
}

/** Assinatura mensal; o Asaas gera a primeira cobrança e a invoiceUrl. */
export function createSubscription(
	config: AsaasConfig,
	input: { customerId: string; nextDueDate: string },
): Promise<AsaasSubscription> {
	return asaasFetch<AsaasSubscription>(config, "/v3/subscriptions", {
		customer: input.customerId,
		billingType: "UNDEFINED", // cliente escolhe pix/boleto/cartão na página
		value: config.planValueCents / 100,
		nextDueDate: input.nextDueDate,
		cycle: "MONTHLY",
	});
}

/**
 * Códigos do módulo agregador (migration 0026, docs/plano-agregador.md).
 *
 * - "P-XXXXXXXX": código do profissional (users.pro_code)
 * - "E-XXXXXXXX": código do estabelecimento agregador (businesses.aggregator_code)
 *
 * Os códigos são gerados no banco (gen_agenva_code) com 8 caracteres do
 * alfabeto abaixo — sem 0/O/1/I/L para não confundir quem digita.
 */

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export type ParsedLinkCode = {
	kind: "professional" | "aggregator";
	code: string;
};

const BODY = new RegExp(`^[${CODE_ALPHABET}]{8}$`);

/**
 * Normaliza o que o usuário digitou (minúsculas, espaços, sem hífen) e diz
 * de quem é o código. Devolve null para qualquer coisa fora do formato.
 */
export function parseLinkCode(input: unknown): ParsedLinkCode | null {
	if (typeof input !== "string") return null;
	const clean = input.toUpperCase().replace(/[\s-]/g, "");
	const prefix = clean.charAt(0);
	const body = clean.slice(1);
	if (!BODY.test(body)) return null;
	if (prefix === "P") return { kind: "professional", code: `P-${body}` };
	if (prefix === "E") return { kind: "aggregator", code: `E-${body}` };
	return null;
}

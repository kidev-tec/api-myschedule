/**
 * Telefone BR no padrão que o app grava (E.164 sem "+": 55 + DDD + número).
 * O link público recebe o que o cliente digitou ("(13) 99209-3812",
 * "+55 13 9…"): sem normalizar, o mesmo cliente virava cadastro duplicado.
 */
export function phoneDigitsBr(raw: string): string {
	const d = raw.replace(/\D/g, "");
	if (d.startsWith("55") && d.length >= 12 && d.length <= 13) return d;
	if (d.length >= 10 && d.length <= 11) return `55${d}`;
	return d;
}

/** Formas que o mesmo telefone pode estar gravado: com e sem o 55. */
export function phoneMatchKeys(raw: string): string[] {
	const full = phoneDigitsBr(raw);
	return full.startsWith("55") && full.length >= 12
		? [full, full.slice(2)]
		: [full];
}

/**
 * Como o profissional aparece para quem não é ele (seletor do link do
 * estabelecimento, avisos de vínculo, convite de calendário).
 *
 * Contas criadas pelo app nascem com o nome genérico "Profissional" — sem o
 * negócio junto, dois profissionais ficam iguais no seletor (achado do E2E de
 * 06/11). Junta o nome do negócio quando ele diz algo a mais.
 */
export function proLabel(
	name: string,
	businessName: string | null | undefined,
): string {
	const n = name.trim();
	const b = businessName?.trim() ?? "";
	if (!b || b.toLowerCase() === n.toLowerCase()) return n;
	if (!n) return b;
	return `${n} (${b})`;
}

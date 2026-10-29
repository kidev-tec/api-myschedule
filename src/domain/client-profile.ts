/**
 * Cadastro complementar do cliente: CPF, como prefere ser chamado, como
 * conheceu, consentimento de mensagens (LGPD) e endereço. Tudo opcional;
 * valida e normaliza num formato pronto pro banco. Mensagens em PT-BR.
 */

export const REFERRAL_SOURCES = [
	"indicacao",
	"instagram",
	"google",
	"passou_na_frente",
	"outro",
] as const;

export type ClientProfile = {
	cpf: string | null;
	nickname: string | null;
	referralSource: string | null;
	marketingConsent: boolean;
	addressZip: string | null;
	addressStreet: string | null;
	addressNumber: string | null;
	addressComplement: string | null;
	addressDistrict: string | null;
	addressCity: string | null;
	addressState: string | null;
};

/** CPF com dígitos verificadores válidos (aceita com ou sem máscara). */
export function isValidCpf(raw: string): boolean {
	const d = raw.replace(/\D/g, "");
	if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
	const digit = (len: number) => {
		let sum = 0;
		for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
		const r = (sum * 10) % 11;
		return r === 10 ? 0 : r;
	};
	return digit(9) === Number(d[9]) && digit(10) === Number(d[10]);
}

type Fail = { error: string };

/** Texto opcional aparado (vazio → null), com limite de tamanho. */
function text(v: unknown, label: string, max: number): string | null | Fail {
	if (v === undefined || v === null) return null;
	if (typeof v !== "string") return { error: `${label} deve ser texto` };
	const t = v.trim();
	if (t.length > max) {
		return { error: `${label}: até ${max} caracteres` };
	}
	return t === "" ? null : t;
}

const isFail = (v: unknown): v is Fail =>
	typeof v === "object" && v !== null && "error" in v;

const ADDRESS_FIELDS = [
	["street", "Endereço (rua)", 200],
	["number", "Endereço (número)", 20],
	["complement", "Endereço (complemento)", 80],
	["district", "Endereço (bairro)", 80],
	["city", "Endereço (cidade)", 80],
] as const;

export function parseClientProfile(
	body: Record<string, unknown>,
): { value: ClientProfile } | Fail {
	// CPF
	let cpf: string | null = null;
	if (body.cpf !== undefined && body.cpf !== null && body.cpf !== "") {
		if (typeof body.cpf !== "string" || !isValidCpf(body.cpf)) {
			return { error: "CPF inválido" };
		}
		cpf = body.cpf.replace(/\D/g, "");
	}

	const nickname = text(body.nickname, "Como prefere ser chamado", 60);
	if (isFail(nickname)) return nickname;

	let referralSource: string | null = null;
	if (body.referral_source !== undefined && body.referral_source !== null) {
		if (
			!REFERRAL_SOURCES.includes(
				body.referral_source as (typeof REFERRAL_SOURCES)[number],
			)
		) {
			return { error: "Como conheceu inválido" };
		}
		referralSource = body.referral_source as string;
	}

	const consent = body.marketing_consent ?? false;
	if (typeof consent !== "boolean") {
		return { error: "Aceita mensagens: consentimento deve ser sim/não" };
	}

	const value: ClientProfile = {
		cpf,
		nickname,
		referralSource,
		marketingConsent: consent,
		addressZip: null,
		addressStreet: null,
		addressNumber: null,
		addressComplement: null,
		addressDistrict: null,
		addressCity: null,
		addressState: null,
	};

	const addr = body.address;
	if (addr !== undefined && addr !== null) {
		if (typeof addr !== "object" || Array.isArray(addr)) {
			return { error: "Endereço deve ser um objeto" };
		}
		const a = addr as Record<string, unknown>;
		const zip = text(a.zip, "Endereço (CEP)", 9);
		if (isFail(zip)) return zip;
		if (zip !== null) {
			const digits = zip.replace(/\D/g, "");
			if (digits.length !== 8) return { error: "CEP inválido" };
			value.addressZip = digits;
		}
		for (const [key, label, max] of ADDRESS_FIELDS) {
			const v = text(a[key], label, max);
			if (isFail(v)) return v;
			const col =
				`address${key.charAt(0).toUpperCase()}${key.slice(1)}` as keyof ClientProfile;
			(value as Record<string, unknown>)[col] = v;
		}
		const uf = text(a.state, "Endereço (UF)", 2);
		if (isFail(uf)) return { error: "UF inválida" };
		if (uf !== null) {
			if (!/^[A-Za-z]{2}$/.test(uf)) return { error: "UF inválida" };
			value.addressState = uf.toUpperCase();
		}
	}
	return { value };
}

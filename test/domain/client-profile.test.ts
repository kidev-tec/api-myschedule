import { describe, expect, it } from "vitest";
import {
	isValidCpf,
	parseClientProfile,
	REFERRAL_SOURCES,
} from "../../src/domain/client-profile.js";

describe("isValidCpf", () => {
	// 10000000108: dígito em que o resto dá 10 (vira 0)
	it.each(["52998224725", "529.982.247-25", "11144477735", "10000000108"])(
		"válido: %s",
		(cpf) => expect(isValidCpf(cpf)).toBe(true),
	);
	it.each(["52998224724", "11111111111", "123", "abc.def.ghi-jk", ""])(
		"inválido: %s",
		(cpf) => expect(isValidCpf(cpf)).toBe(false),
	);
});

describe("parseClientProfile", () => {
	it("tudo ausente → nulos e consentimento false", () => {
		expect(parseClientProfile({})).toEqual({
			value: {
				cpf: null,
				nickname: null,
				referralSource: null,
				marketingConsent: false,
				addressZip: null,
				addressStreet: null,
				addressNumber: null,
				addressComplement: null,
				addressDistrict: null,
				addressCity: null,
				addressState: null,
			},
		});
	});

	it("normaliza CPF/CEP pra dígitos, UF maiúscula e apara textos", () => {
		const r = parseClientProfile({
			cpf: "529.982.247-25",
			nickname: "  Dudu ",
			referral_source: "instagram",
			marketing_consent: true,
			address: {
				zip: "17012-000",
				street: " Rua X ",
				number: "10",
				complement: "",
				district: "Centro",
				city: "Bauru",
				state: "sp",
			},
		});
		expect(r).toEqual({
			value: {
				cpf: "52998224725",
				nickname: "Dudu",
				referralSource: "instagram",
				marketingConsent: true,
				addressZip: "17012000",
				addressStreet: "Rua X",
				addressNumber: "10",
				addressComplement: null,
				addressDistrict: "Centro",
				addressCity: "Bauru",
				addressState: "SP",
			},
		});
	});

	it("endereço parcial (sem CEP/UF) é aceito", () => {
		const r = parseClientProfile({ address: { city: "Bauru" } });
		expect(r).toMatchObject({
			value: { addressCity: "Bauru", addressZip: null, addressState: null },
		});
	});

	it("aceita todas as origens da lista", () => {
		for (const s of REFERRAL_SOURCES) {
			expect(parseClientProfile({ referral_source: s })).not.toHaveProperty(
				"error",
			);
		}
	});

	it.each([
		[{ cpf: "11111111111" }, "CPF inválido"],
		[{ cpf: 123 }, "CPF inválido"],
		[{ nickname: 5 }, "Como prefere ser chamado deve ser texto"],
		[{ nickname: "x".repeat(61) }, "até 60 caracteres"],
		[{ referral_source: "tiktok" }, "Como conheceu inválido"],
		[{ marketing_consent: "sim" }, "consentimento"],
		[{ address: "Rua X" }, "Endereço"],
		[{ address: { zip: "123" } }, "CEP inválido"],
		[{ address: { state: "São Paulo" } }, "UF inválida"],
		[{ address: { state: "S1" } }, "UF inválida"],
		[{ address: { zip: 17012000 } }, "CEP"],
		[{ address: { street: 1 } }, "Endereço"],
		[{ address: { city: "x".repeat(81) } }, "até 80 caracteres"],
	])("erro: %j → %s", (body, msg) => {
		const r = parseClientProfile(body as Record<string, unknown>);
		expect("error" in r && r.error).toContain(msg);
	});
});

import { describe, expect, it } from "vitest";
import { parseLinkCode } from "../../src/domain/link-code.js";

describe("parseLinkCode — código digitado pelo usuário", () => {
	it("código de profissional (P-) no formato canônico", () => {
		expect(parseLinkCode("P-7K3M9QXT")).toEqual({
			kind: "professional",
			code: "P-7K3M9QXT",
		});
	});

	it("código de estabelecimento (E-)", () => {
		expect(parseLinkCode("E-4HWN2RBC")).toEqual({
			kind: "aggregator",
			code: "E-4HWN2RBC",
		});
	});

	it("aceita minúsculas, espaços e sem o hífen", () => {
		expect(parseLinkCode("  p 7k3m 9qxt ")).toEqual({
			kind: "professional",
			code: "P-7K3M9QXT",
		});
		expect(parseLinkCode("e4hwn2rbc")).toEqual({
			kind: "aggregator",
			code: "E-4HWN2RBC",
		});
	});

	it("rejeita caracteres fora do alfabeto (0, O, 1, I, L)", () => {
		expect(parseLinkCode("P-7K3M9QXI")).toBeNull();
		expect(parseLinkCode("P-0K3M9QXT")).toBeNull();
		expect(parseLinkCode("P-OK3M9QXT")).toBeNull();
		expect(parseLinkCode("E-1HWN2RBC")).toBeNull();
		expect(parseLinkCode("E-LHWN2RBC")).toBeNull();
	});

	it("rejeita prefixo desconhecido, tamanho errado e não-string", () => {
		expect(parseLinkCode("X-7K3M9QXT")).toBeNull();
		expect(parseLinkCode("P-7K3M9QX")).toBeNull();
		expect(parseLinkCode("P-7K3M9QXTA")).toBeNull();
		expect(parseLinkCode("")).toBeNull();
		expect(parseLinkCode(123)).toBeNull();
		expect(parseLinkCode(undefined)).toBeNull();
	});
});

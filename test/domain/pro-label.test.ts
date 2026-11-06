import { describe, expect, it } from "vitest";
import { proLabel } from "../../src/domain/pro-label.js";

describe("proLabel — nome do profissional para o outro lado", () => {
	it("junta o negócio quando é diferente do nome", () => {
		expect(proLabel("Profissional", "Kim Salão")).toBe(
			"Profissional (Kim Salão)",
		);
	});

	it("negócio igual ao nome (sem diferenciar maiúsculas) não repete", () => {
		expect(proLabel("Ana Beleza", "ana beleza")).toBe("Ana Beleza");
	});

	it("sem negócio fica só o nome; sem nome fica só o negócio", () => {
		expect(proLabel(" Ana ", null)).toBe("Ana");
		expect(proLabel("Ana", undefined)).toBe("Ana");
		expect(proLabel("Ana", "  ")).toBe("Ana");
		expect(proLabel("", "Kim Salão")).toBe("Kim Salão");
	});
});

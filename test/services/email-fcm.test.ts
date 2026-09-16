/**
 * Unit tests dos services de email e FCM — cobre os branches de erro
 * (resend não-ok, exceção de rede, token morto, err sem code, etc).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.hoisted(() =>
	vi.fn<
		(args: {
			token: string;
			notification: { title: string; body: string };
		}) => Promise<string>
	>(async () => "ok"),
);

vi.mock("firebase-admin/app", () => ({
	getApps: vi.fn(() => [{} as never]),
}));
vi.mock("firebase-admin/messaging", () => ({
	getMessaging: () => ({ send: sendMock }),
}));

import {
	sendEmail,
	trialEndingEmail,
	welcomeEmail,
} from "../../src/services/email.js";
import { sendToUser } from "../../src/services/fcm.js";

const DATABASE_URL =
	process.env.TEST_DATABASE_URL ??
	"postgres://postgres:dev@localhost:5433/minha_agenda_dev";

const sql = (await import("postgres")).default(DATABASE_URL);

// user + token de teste direto no banco (isolado por firebase_uid único)
const uid = `fcm-unit-${Date.now()}`;
let userId = "";

beforeEach(async () => {
	sendMock.mockClear();
	// limpa resíduos de execuções anteriores com o mesmo segundo? uid é único
	const biz = await sql`
		INSERT INTO businesses (name, slug, business_type)
		VALUES (${`FcmUnit ${uid}`}, ${`fcmunit-${uid}`}, 'beauty')
		RETURNING id
	`;
	const user = await sql`
		INSERT INTO users (business_id, firebase_uid, email, name, role)
		VALUES (${biz[0]!.id}, ${uid}, ${`${uid}@t.com`}, 'Fcm Unit', 'owner')
		RETURNING id
	`;
	userId = user[0]!.id;
});

afterEach(async () => {
	await sql`DELETE FROM device_tokens WHERE user_id = ${userId}`;
	await sql`DELETE FROM users WHERE id = ${userId}`;
	await sql`DELETE FROM businesses WHERE slug = ${`fcmunit-${uid}`}`;
});

describe("email adapter", () => {
	it("sem RESEND_API_KEY: log-only, não chama fetch", async () => {
		const prev = process.env.RESEND_API_KEY;
		delete process.env.RESEND_API_KEY;
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			await sendEmail({ to: "a@b.c", subject: "s", html: "<p>x</p>" });
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			if (prev !== undefined) process.env.RESEND_API_KEY = prev;
			fetchSpy.mockRestore();
		}
	});

	it("com RESEND_API_KEY: chama resend com payload certo", async () => {
		process.env.RESEND_API_KEY = "test-key";
		const bodies: string[] = [];
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input, init) => {
				bodies.push(String(init?.body ?? ""));
				expect(String(input)).toContain("resend.com/emails");
				return new Response(JSON.stringify({ id: "1" }), { status: 200 });
			});
		try {
			await sendEmail({ to: "a@b.c", subject: "s", html: "<p>x</p>" });
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(bodies[0]).toContain("a@b.c");
		} finally {
			delete process.env.RESEND_API_KEY;
			fetchSpy.mockRestore();
		}
	});

	it("resend responde erro → loga, não lança", async () => {
		process.env.RESEND_API_KEY = "test-key";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("err", { status: 500 }));
		try {
			await expect(
				sendEmail({ to: "a@b.c", subject: "s", html: "x" }),
			).resolves.toBeUndefined();
		} finally {
			delete process.env.RESEND_API_KEY;
			fetchSpy.mockRestore();
		}
	});

	it("rede caiu → engole a exceção", async () => {
		process.env.RESEND_API_KEY = "test-key";
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => {
				throw new Error("offline");
			});
		try {
			await expect(
				sendEmail({ to: "a@b.c", subject: "s", html: "x" }),
			).resolves.toBeUndefined();
		} finally {
			delete process.env.RESEND_API_KEY;
			fetchSpy.mockRestore();
		}
	});

	it("templates personalizados com nome do negócio", () => {
		const w = welcomeEmail("Studio Bella");
		expect(w.subject).toContain("Studio Bella");
		const t = trialEndingEmail("Studio Bella", 2);
		expect(t.subject).toContain("2 dias");
		const t1 = trialEndingEmail("Studio Bella", 1);
		expect(t1.subject).toContain("1 dia");
		expect(t1.subject).not.toContain("dias de teste, Studio Bella! faltam");
	});
});

describe("fcm.sendToUser", () => {
	it("user sem token: não chama send", async () => {
		await sendToUser(DATABASE_URL, userId, "t", "b");
		expect(sendMock).not.toHaveBeenCalled();
	});

	it("envia para os tokens do user", async () => {
		await sql`
			INSERT INTO device_tokens (user_id, fcm_token, platform)
			VALUES (${userId}, ${`tok-${uid}-1`}, 'android')
		`;
		await sendToUser(DATABASE_URL, userId, "Segunda", "msg"); // 2a usa cache
		await sendToUser(DATABASE_URL, userId, "Novo agendamento", "corpo");
		expect(sendMock).toHaveBeenCalledTimes(2);
		expect(sendMock.mock.calls[0]?.[0]?.token).toBe(`tok-${uid}-1`);
	});

	it("token morto (registration-token-not-registered) é removido", async () => {
		await sql`
			INSERT INTO device_tokens (user_id, fcm_token, platform)
			VALUES (${userId}, ${`tok-${uid}-dead`}, 'android')
		`;
		sendMock.mockImplementationOnce(async () => {
			const err = new Error("unregistered") as Error & { code: string };
			err.code = "messaging/registration-token-not-registered";
			throw err;
		});
		await sendToUser(DATABASE_URL, userId, "t", "b");
		const rows = await sql`
			SELECT 1 FROM device_tokens WHERE fcm_token = ${`tok-${uid}-dead`}
		`;
		expect(rows.length).toBe(0);
	});

	it("erro SEM code conhecido: token fica, erro é logado", async () => {
		await sql`
			INSERT INTO device_tokens (user_id, fcm_token, platform)
			VALUES (${userId}, ${`tok-${uid}-ok`}, 'android')
		`;
		sendMock.mockImplementationOnce(async () => {
			throw new Error("boom sem code");
		});
		await expect(
			sendToUser(DATABASE_URL, userId, "t", "b"),
		).resolves.toBeUndefined();
		const rows = await sql`
			SELECT 1 FROM device_tokens WHERE fcm_token = ${`tok-${uid}-ok`}
		`;
		expect(rows.length).toBe(1);
	});
});
describe("fcm.sendToUser catch global (linha 74)", () => {
	it("getDb lança → engole (nunca lança)", async () => {
		const dbMod = await import("../../src/db/connection.js");
		const spy = vi.spyOn(dbMod, "getDb").mockImplementation(() => {
			throw new Error("db down");
		});
		try {
			await expect(
				sendToUser(DATABASE_URL, userId, "t", "b"),
			).resolves.toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});
});

describe("trialEndingEmail daysLeft <= 0", () => {
	it("template de teste encerrado", () => {
		const t = trialEndingEmail("Studio X", 0);
		expect(t.subject).toContain("terminou");
		expect(t.html).toContain("terminou");
	});
});

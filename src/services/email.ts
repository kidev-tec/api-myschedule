/**
 * Adapter de email (Resend). Sem RESEND_API_KEY = modo dev (log only).
 * sendEmail NUNCA lança: email é best-effort e nunca bloqueia a request.
 */

export type EmailPayload = { to: string; subject: string; html: string };

export function isEmailEnabled(): boolean {
	return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(payload: EmailPayload): Promise<void> {
	try {
		if (!isEmailEnabled()) {
			console.log(
				`[email:dev] para=${payload.to} assunto="${payload.subject}"`,
			);
			return;
		}
		const from =
			process.env.EMAIL_FROM ?? "Minha Agenda <onboarding@resend.dev>";
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from,
				to: [payload.to],
				subject: payload.subject,
				html: payload.html,
			}),
		});
		if (!res.ok) {
			console.error("[email] resend respondeu", res.status);
		}
	} catch (e) {
		console.error("[email] envio falhou (ignorado):", e);
	}
}

/** Welcome no primeiro login — nome do negócio personaliza o assunto. */
export function welcomeEmail(name: string): EmailPayload {
	return {
		to: "",
		subject: `Bem-vindo ao Minha Agenda, ${name}!`,
		html: `<h1>Bem-vindo, ${name}!</h1><p>Tua conta foi criada e teus 15 dias de teste começaram. Qualquer coisa, é só chamar.</p>`,
	};
}

/** Lembrete de trial terminando — enviado 1x/dia pelo endpoint interno. */
export function trialEndingEmail(name: string, daysLeft: number): EmailPayload {
	return {
		to: "",
		subject:
			daysLeft <= 0
				? `Minha Agenda: teu teste terminou, ${name}`
				: `Minha Agenda: faltam ${daysLeft} dia${daysLeft === 1 ? "" : "s"} de teste, ${name}`,
		html: `<p>Olá, ${name}!</p><p>Teu período de teste ${
			daysLeft <= 0
				? "terminou. Assina pra continuar agendando sem interrupção."
				: `termina em <b>${daysLeft} dia${daysLeft === 1 ? "" : "s"}</b>.`
		}</p>`,
	};
}

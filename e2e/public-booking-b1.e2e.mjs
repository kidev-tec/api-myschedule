import { chromium } from "playwright";
import postgres from "postgres";

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787";
const db = postgres(
	process.env.E2E_DATABASE_URL ??
		"postgres://postgres:dev@localhost:5433/minha_agenda_dev",
);
const slug = `e2e-b1-${Date.now()}`;

function assert(value, message) {
	if (!value) throw new Error(message);
}

async function main() {
	let browser;
	try {
		// Cria fixture real diretamente no banco. O browser só usa HTTP público.
		const [{ id: businessId }] = await db`
			insert into businesses (name, slug, subscription_status, trial_ends_at)
			values ('E2E B1', ${slug}, 'trial', now() + interval '1 day')
			returning id`;
		const [{ id: userId }] = await db`
			insert into users (firebase_uid, email, name, business_id)
			values (${`e2e-b1-${Date.now()}`}, ${`${slug}@e2e.local`}, 'Profissional E2E', ${businessId})
			returning id`;
		const [{ id: shortId }] = await db`
			insert into services (business_id, name, duration_min, price_cents)
			values (${businessId}, 'Serviço curto', 30, 0) returning id`;
		const [{ id: longId }] = await db`
			insert into services (business_id, name, duration_min, price_cents)
			values (${businessId}, 'Serviço longo', 60, 0) returning id`;

		const tomorrow = new Date(Date.now() + 86_400_000);
		// A página monta seus dias no fuso local do navegador. Normaliza a data
		// local para fixture/busy não cair no dia UTC anterior.
		tomorrow.setHours(12, 0, 0, 0);
		const weekday = tomorrow.getDay();
		await db`
			insert into working_hours (user_id, weekday, start_time, end_time)
			values (${userId}, ${weekday}, '08:00', '18:00')`;
		const date = tomorrow.toISOString().slice(0, 10);
		const at = (time) => new Date(`${date}T${time}:00`).toISOString();
		// bloqueia 10:00–10:30. 09:30 vale p/ 30min; não vale p/ 60min.
		const [{ id: clientId }] = await db`
			insert into clients (business_id, name, phone_e164)
			values (${businessId}, 'Bloqueio E2E', '14999999000') returning id`;
		await db`
			insert into appointments (business_id, user_id, client_id, service_id, starts_at, ends_at, status, source)
			values (${businessId}, ${userId}, ${clientId}, ${shortId}, ${at("10:00")}, ${at("10:30")}, 'pending', 'app')`;

		browser = await chromium.launch({
			headless: true,
			executablePath: "/usr/bin/google-chrome",
			args: ["--no-sandbox"],
		});
		const page = await browser.newPage();
		await page.goto(`${base}/p/${slug}`, { waitUntil: "networkidle" });

		// seleciona curto, amanhã, 09:30
		await page.getByText("Serviço curto · 30min").click();
		await page.locator("#days .slot").nth(1).click(); // amanhã (lista começa hoje)
		await page.getByText("09:30", { exact: true }).click();
		assert(
			await page.getByText("09:30", { exact: true }).evaluate((el) => el.classList.contains("sel")),
			"pré-condição: 09:30 deveria estar selecionado",
		);

		// Compatível: mesmo serviço recarrega e PRESERVA horário.
		await page.getByText("Serviço curto · 30min").click();
		await page.waitForTimeout(150);
		assert(
			await page.getByText("09:30", { exact: true }).evaluate((el) => el.classList.contains("sel")),
			"B1 falhou: 09:30 compatível foi perdido ao trocar serviço",
		);

		// Incompatível: serviço 60min choca 10:00–10:30, limpa + explica.
		await page.getByText("Serviço longo · 60min").click();
		await page.waitForTimeout(150);
		assert(
			!(await page.getByText("09:30", { exact: true }).evaluate((el) => el.classList.contains("sel"))),
			"B1 falhou: 09:30 incompatível continuou selecionado",
		);
		assert(
			(await page.locator("#err").textContent())?.includes(
				"o horário escolhido não está disponível para este serviço",
			),
			"B1 falhou: ausência de mensagem para horário incompatível",
		);
		console.log("PASS B1 E2E: preserva compatível; limpa incompatível com aviso.");

		// Roteiro final: finalizar agendamento válido (slot compatível preservado).
		await page.getByText("Serviço curto · 30min").click(); // volta pro serviço compatível
		await page.waitForTimeout(150);
		await page.locator("#nm").fill("Cliente Roteiro");
		await page.locator("#ph").fill("14998887766");
		await page.getByText("09:30", { exact: true }).click();
		await page.locator("#go").click();
		await page.getByText("Horário agendado!").waitFor({ timeout: 10_000 });
		const [{ count }] = await db`
			select count(*)::int as count from appointments
			where business_id in (select id from businesses where slug = ${slug})
				and source = 'public_link'`;
		assert(count === 1, `B1 falhou: booking final não persistiu (count=${count})`);
		console.log("PASS B1 E2E: agendamento válido finalizado e persistido (source=public_link).");
	} finally {
		await browser?.close();
		await db`delete from appointments where business_id in (select id from businesses where slug = ${slug})`;
		await db`delete from clients where business_id in (select id from businesses where slug = ${slug})`;
		await db`delete from services where business_id in (select id from businesses where slug = ${slug})`;
		await db`delete from working_hours where user_id in (select id from users where email = ${`${slug}@e2e.local`})`;
		await db`delete from users where email = ${`${slug}@e2e.local`}`;
		await db`delete from businesses where slug = ${slug}`;
		await db.end();
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

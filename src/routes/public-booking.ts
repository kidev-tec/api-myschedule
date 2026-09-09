/**
 * RF-07 — Link público de agendamento.
 *
 * Rotas SEM auth Firebase (o cliente do salão não tem conta):
 * - GET  /p/:slug       → página HTML standalone (zero build, inline CSS/JS)
 * - GET  /p/:slug/info  → JSON { business, services, working_hours }
 * - POST /p/:slug/book  → { name, phone, service_id, starts_at } → cria
 *                          client (find-or-create por telefone) + appointment
 *                          pending com source='public_link'
 *
 * Segurança: slug é a única credencial. Rate-limiting básico em memória
 * (10 bookings/min/IP). Paywall respeitado: business com trial vencido
 * responde 402 no book (leitura/info continua livre).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { type Db, getDb } from "../db/connection.js";
import {
	appointments,
	businesses,
	clients,
	services,
	users,
	workingHours,
} from "../db/schema.js";
import { overlaps } from "../domain/booking.js";

function isUuid(v: unknown): v is string {
	return (
		typeof v === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
	);
}

// ---- rate limit em memória (por processo; ok pra MVP single-instância)
const hits = new Map<string, number[]>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
	const now = Date.now();
	const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
	arr.push(now);
	hits.set(key, arr);
	return arr.length > max;
}

/** Limpa contadores (uso em testes). */
export function resetRateLimit() {
	hits.clear();
}

type Loaded = {
	biz: typeof businesses.$inferSelect;
	pro: typeof users.$inferSelect;
} | null;

async function loadBySlug(db: Db, slug: string): Promise<Loaded> {
	const biz = (
		await db.select().from(businesses).where(eq(businesses.slug, slug)).limit(1)
	)[0];
	if (!biz) return null;
	// primeiro usuário do business = profissional dono do link (MVP: 1 prof)
	const pro = (
		await db.select().from(users).where(eq(users.businessId, biz.id)).limit(1)
	)[0];
	/* v8 ignore next 3 -- inatingível: todo business nasce com user (sync atômico) */
	if (!pro) return null;
	return { biz, pro };
}

function canWrite(status: string | null, trialEndsAt: Date | null): boolean {
	if (status === "active") return true;
	if (status === "trial")
		return trialEndsAt === null || trialEndsAt > new Date();
	return false;
}

function infoJson(
	loaded: NonNullable<Loaded>,
	svc: unknown[],
	hours: unknown[],
) {
	return {
		business: {
			name: loaded.biz.name,
			business_type: loaded.biz.businessType,
			timezone: loaded.biz.timezone,
		},
		professional: { name: loaded.pro.name },
		services: svc,
		working_hours: hours,
	};
}

export function publicBookingRoutes(databaseUrl: string) {
	const db = getDb(databaseUrl);
	const routes = new Hono();

	// ---- JSON: perfil + serviços + horários
	routes.get("/p/:slug/info", async (c) => {
		const slug = c.req.param("slug");
		const loaded = await loadBySlug(db, slug);
		if (!loaded) return c.json({ error: "link não encontrado" }, 404);

		const svc = await db
			.select({
				id: services.id,
				name: services.name,
				duration_min: services.durationMin,
				price_cents: services.priceCents,
			})
			.from(services)
			.where(
				and(
					eq(services.businessId, loaded.biz.id),
					isNull(services.archivedAt),
				),
			);
		const hours = await db
			.select({
				weekday: workingHours.weekday,
				start_time: workingHours.startTime,
				end_time: workingHours.endTime,
			})
			.from(workingHours)
			.where(eq(workingHours.userId, loaded.pro.id));

		return c.json(infoJson(loaded, svc, hours));
	});

	// ---- booking público
	routes.post("/p/:slug/book", async (c) => {
		const ip =
			c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
		if (rateLimited(`book:${ip}`, 10, 60_000)) {
			return c.json({ error: "muitas tentativas, aguarde um minuto" }, 429);
		}

		const slug = c.req.param("slug");
		const loaded = await loadBySlug(db, slug);
		if (!loaded) return c.json({ error: "link não encontrado" }, 404);

		if (!canWrite(loaded.biz.subscriptionStatus, loaded.biz.trialEndsAt)) {
			return c.json(
				{ error: "agenda temporariamente indisponível para novos horários" },
				402,
			);
		}

		const body = (await c.req.json().catch(() => null)) as {
			name?: unknown;
			phone?: unknown;
			service_id?: unknown;
			starts_at?: unknown;
		} | null;
		const name =
			typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
		const phone =
			typeof body?.phone === "string" ? body.phone.replace(/[^\d+]/g, "") : "";
		const digits = phone.replace(/\D/g, "");
		if (name.length < 1 || digits.length < 10) {
			return c.json(
				{ error: "informe nome e telefone válidos (com DDD)" },
				400,
			);
		}
		if (typeof body?.service_id !== "string" || !isUuid(body.service_id)) {
			return c.json({ error: "escolha um serviço" }, 400);
		}
		const svc = (
			await db
				.select()
				.from(services)
				.where(
					and(
						eq(services.id, body.service_id),
						eq(services.businessId, loaded.biz.id),
						isNull(services.archivedAt),
					),
				)
				.limit(1)
		)[0];
		if (!svc) return c.json({ error: "serviço indisponível" }, 400);

		const startsAtRaw = body?.starts_at;
		const start = new Date(
			typeof startsAtRaw === "string" ? startsAtRaw : "inválido",
		);
		if (Number.isNaN(start.getTime())) {
			return c.json({ error: "horário inválido" }, 400);
		}
		if (start.getTime() < Date.now()) {
			return c.json({ error: "escolha um horário no futuro" }, 400);
		}
		const end = new Date(start.getTime() + svc.durationMin * 60_000);

		// conflito (mesma semântica do CRUD autenticado)
		const existing = await db
			.select({ startsAt: appointments.startsAt, endsAt: appointments.endsAt })
			.from(appointments)
			.where(
				and(
					eq(appointments.businessId, loaded.biz.id),
					eq(appointments.userId, loaded.pro.id),
					sql`${appointments.status} IN ('pending', 'confirmed')`,
				),
			);
		for (const row of existing) {
			if (overlaps(row.startsAt, row.endsAt, start, end)) {
				return c.json({ error: "esse horário acabou de ser ocupado" }, 409);
			}
		}

		// find-or-create client por telefone (E.164-ish)
		let client = (
			await db
				.select()
				.from(clients)
				.where(
					and(
						eq(clients.businessId, loaded.biz.id),
						eq(clients.phoneE164, phone),
					),
				)
				.limit(1)
		)[0];
		if (!client) {
			client = (
				await db
					.insert(clients)
					.values({
						businessId: loaded.biz.id,
						name,
						phoneE164: phone,
					})
					.returning()
			)[0];
			/* v8 ignore next 2 -- .returning() de insert válido nunca retorna vazio */
			if (!client) return c.json({ error: "falha ao registrar cliente" }, 500);
		}

		const [created] = await db
			.insert(appointments)
			.values({
				businessId: loaded.biz.id,
				clientId: client.id,
				serviceId: svc.id,
				userId: loaded.pro.id,
				startsAt: start,
				endsAt: end,
				status: "pending",
				source: "public_link",
			})
			.returning();

		/* v8 ignore next 2 -- .returning() de insert válido nunca retorna vazio */
		if (!created) return c.json({ error: "falha ao criar agendamento" }, 500);
		return c.json(
			{
				id: created.id,
				status: created.status,
				starts_at: created.startsAt,
				ends_at: created.endsAt,
				service: svc.name,
				business: loaded.biz.name,
			},
			201,
		);
	});

	// ---- HTML da página pública (última, pra não engolir as rotas acima)
	routes.get("/p/:slug", (c) => {
		const slug = c.req.param("slug");
		return c.html(publicPageHtml(slug));
	});

	return routes;
}

/** Página standalone: zero build, CSS/JS inline, mobile-first. */
function publicPageHtml(slug: string): string {
	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
	const s = esc(slug);
	return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agendar horário</title>
<style>
:root{--p:#B51F4D;--bg:#FAF7F5;--tx:#2B2226;--mut:#8A7B81}
*{box-sizing:border-box;margin:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--tx);padding:20px;max-width:520px;margin:0 auto}
h1{font-size:1.4rem;margin:8px 0 2px}
.mut{color:var(--mut);font-size:.9rem}
.card{background:#fff;border-radius:14px;padding:16px;margin:14px 0;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.svc{display:flex;justify-content:space-between;align-items:center;padding:12px;border:1.5px solid #eee;border-radius:10px;margin:8px 0;cursor:pointer}
.svc.sel{border-color:var(--p);background:#FDF0F4}
label{display:block;font-size:.85rem;font-weight:600;margin:12px 0 4px}
input{width:100%;padding:12px;border:1.5px solid #ddd;border-radius:10px;font-size:1rem}
button{width:100%;padding:14px;border:0;border-radius:12px;background:var(--p);color:#fff;font-size:1rem;font-weight:700;margin-top:16px;cursor:pointer}
button:disabled{opacity:.5}
.err{background:#FDECEC;color:#8B1E33;padding:10px;border-radius:10px;margin:10px 0;font-size:.9rem;display:none}
.ok{text-align:center;padding:30px 10px}
.ok .big{font-size:3rem}
.slots{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
.slot{padding:10px 12px;border:1.5px solid #ddd;border-radius:10px;cursor:pointer;font-size:.9rem}
.slot.sel{border-color:var(--p);background:#FDF0F4;font-weight:700}
</style>
</head>
<body>
<div id="app"><h1>Carregando…</h1></div>
<script>
const SLUG = "${s}";
const app = document.getElementById('app');
let INFO = null, SEL = null, DAY = null;

init();
async function init(){
  try{
    const r = await fetch('/p/'+SLUG+'/info');
    if(!r.ok) throw 0;
    INFO = await r.json();
    renderForm();
  }catch(e){
    app.innerHTML = '<div class="card"><h1>Link inválido</h1><p class="mut">Essa agenda não existe ou foi removida.</p></div>';
  }
}

function brl(c){return (c/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})}

function renderForm(msg){
  const days = [];
  for(let i=0;i<14;i++){
    const d = new Date(); d.setDate(d.getDate()+i);
    days.push(d);
  }
  app.innerHTML = \`
    <h1>\${INFO.business.name}</h1>
    <p class="mut">com \${INFO.professional.name} · agende teu horário</p>
    <div class="err" id="err"></div>
    <div class="card">
      <label>1. Escolhe o serviço</label>
      \${INFO.services.map(s=>\`<div class="svc\${SEL===s.id?' sel':''}" onclick="pick('\${s.id}')">
        <span>\${s.name} · \${s.duration_min}min</span><b>\${brl(s.price_cents)}</b></div>\`).join('')}
      <label>2. Teus dados</label>
      <input id="nm" placeholder="Teu nome">
      <input id="ph" placeholder="WhatsApp (com DDD)" inputmode="tel" style="margin-top:8px">
      <label>3. Escolhe o dia</label>
      <div class="slots" id="days"></div>
      <label>4. Horários livres (\${DAY?DAY.toLocaleDateString('pt-BR'):'—'})</label>
      <div class="slots" id="slots"><span class="mut">escolhe um dia acima</span></div>
      <button id="go" onclick="book()">Confirmar agendamento</button>
    </div>\`;
  const dw = document.getElementById('days');
  days.forEach(d=>{
    const el = document.createElement('div');
    el.className='slot';
    el.textContent = d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'});
    el.onclick = ()=>{ DAY=d; [...dw.children].forEach(x=>x.classList.remove('sel')); el.classList.add('sel'); loadSlots(); };
    dw.appendChild(el);
  });
  if(msg){ const e=document.getElementById('err'); e.textContent=msg; e.style.display='block'; }
}
window.pick = id => { SEL=id; renderForm(); };

async function loadSlots(){
  // slots de 15min entre abrir/fechar do dia, checando conflitos no book
  const slots = document.getElementById('slots');
  slots.innerHTML = '<span class="mut">carregando…</span>';
  // info.working_hours: weekday 0-6
  const wd = DAY.getDay();
  const h = INFO.working_hours.find(x=>x.weekday===wd);
  if(!h){ slots.innerHTML='<span class="mut">fechado neste dia</span>'; return; }
  const [sh,sm] = h.start_time.split(':').map(Number);
  const [eh] = h.end_time.split(':').map(Number);
  const out=[];
  for(let m=sh*60+sm; m<eh*60; m+=15){
    const d = new Date(DAY); d.setHours(Math.floor(m/60), m%60, 0, 0);
    if(d > new Date()) out.push(d);
  }
  slots.innerHTML='';
  out.forEach(d=>{
    const el=document.createElement('div'); el.className='slot';
    el.textContent=d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    el.onclick=()=>{ window.PICKED=d; [...slots.children].forEach(x=>x.classList.remove('sel')); el.classList.add('sel'); };
    slots.appendChild(el);
  });
}

async function book(){
  const nm=document.getElementById('nm').value.trim();
  const ph=document.getElementById('ph').value.trim();
  const e=document.getElementById('err');
  if(!SEL){ e.textContent='escolhe um serviço'; e.style.display='block'; return; }
  if(!window.PICKED){ e.textContent='escolhe um horário'; e.style.display='block'; return; }
  const btn=document.getElementById('go'); btn.disabled=true;
  try{
    const r = await fetch('/p/'+SLUG+'/book',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:nm, phone:ph, service_id:SEL, starts_at:window.PICKED.toISOString() })
    });
    const d = await r.json();
    if(!r.ok){ btn.disabled=false; renderForm(d.error||'erro'); return; }
    const when = new Date(d.starts_at).toLocaleString('pt-BR',{weekday:'long',day:'2-digit',month:'long',hour:'2-digit',minute:'2-digit'});
    app.innerHTML = \`<div class="ok card"><div class="big">✅</div>
      <h1>Horário agendado!</h1>
      <p class="mut">\${d.service} em \${d.business}</p>
      <p style="margin-top:10px;font-weight:700">\${when}</p>
      <p class="mut" style="margin-top:10px">Te esperamos! Chega na hora 😉</p></div>\`;
  }catch(err){ btn.disabled=false; renderForm('sem conexão, tenta de novo'); }
}
</script>
</body>
</html>`;
}

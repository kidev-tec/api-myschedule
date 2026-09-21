/**
 * OpenAPI 3.1 — Minha Agenda API
 *
 * Escrito à mão de propósito: as rotas usam validação manual (sem
 * zod-openapi), e refatorar 27 rotas pra gerar spec automática não vale o
 * custo agora. Manter este arquivo em sync ao adicionar rota nova — o
 * teste openapi-docs.test.ts garante que toda rota registrada aparece aqui.
 */
export const openApiSpec = {
	openapi: "3.1.0",
	info: {
		title: "Minha Agenda API",
		version: "1.0.0",
		description:
			"API do Minha Agenda — agendamento para prestadores de serviço " +
			"(beleza, saúde, etc). Autenticação via Firebase ID token " +
			"(Authorization: Bearer). Paywall: rotas de escrita exigem assinatura " +
			"trial/active (402 quando expira). Link público /p/:slug é anônimo.",
		contact: {
			name: "Rafael Zendron",
			url: "https://github.com/pianolouvorja",
		},
	},
	servers: [{ url: "http://localhost:3200", description: "dev local" }],
	tags: [
		{ name: "Auth", description: "Sync de usuário Firebase ↔ business" },
		{ name: "Business", description: "Perfil do estabelecimento" },
		{ name: "Services", description: "Catálogo de serviços do prestador" },
		{ name: "Clients", description: "Clientes do prestador" },
		{ name: "Appointments", description: "Agenda do prestador" },
		{ name: "WorkingHours", description: "Horário de funcionamento" },
		{
			name: "PublicBooking",
			description: "Agendamento público (link /p/:slug)",
		},
		{ name: "GCal", description: "Espelho Google Calendar do prestador" },
		{ name: "Meta", description: "Health, versão, docs" },
	],
	components: {
		securitySchemes: {
			firebaseAuth: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "JWT",
				description: "Firebase ID token do app (Authorization: Bearer <token>)",
			},
		},
		schemas: {
			Error: {
				type: "object",
				properties: {
					error: { type: "string" },
					hint: { type: "string", description: "Dica de correção (opcional)" },
				},
				required: ["error"],
			},
			Business: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					name: { type: "string" },
					slug: {
						type: "string",
						description:
							"Identificador do link público /p/:slug. Único; gerado como <nome-slugificado>-<firebaseUid>.",
					},
					businessType: { type: "string", enum: ["beauty", "health", "other"] },
					subscriptionStatus: {
						type: "string",
						enum: ["trial", "active", "canceled", "past_due"],
					},
					trialEndsAt: { type: "string", format: "date-time" },
					gcalConnected: {
						type: "boolean",
						description:
							"true se o prestador conectou o Google Calendar (RF-08)",
					},
				},
			},
			Service: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					name: { type: "string" },
					priceCents: {
						type: "integer",
						description: "Preço em centavos (BRL)",
					},
					durationMin: { type: "integer", description: "Duração em minutos" },
					active: { type: "boolean" },
				},
				required: ["name", "priceCents", "durationMin"],
			},
			Client: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					name: { type: "string" },
					phone: {
						type: "string",
						description: "E.164 sem + (ex: 5514999999999)",
					},
					notes: { type: "string" },
				},
				required: ["name", "phone"],
			},
			Appointment: {
				type: "object",
				properties: {
					id: { type: "string", format: "uuid" },
					clientId: { type: "string", format: "uuid" },
					serviceId: { type: "string", format: "uuid" },
					startsAt: { type: "string", format: "date-time" },
					endsAt: { type: "string", format: "date-time" },
					status: {
						type: "string",
						enum: ["pending", "confirmed", "done", "cancelled"],
					},
					gcalEventId: {
						type: "string",
						nullable: true,
						description: "ID do evento espelhado no Google Calendar (RF-08)",
					},
				},
			},
			WorkingHours: {
				type: "object",
				description: "Mapa dia-da-semana (0=dom) → janelas de atendimento",
				additionalProperties: {
					type: "array",
					items: {
						type: "object",
						properties: {
							start: { type: "string", example: "09:00" },
							end: { type: "string", example: "18:00" },
						},
					},
				},
			},
		},
	},
	security: [{ firebaseAuth: [] }],
	paths: {
		"/health": {
			get: {
				tags: ["Meta"],
				summary: "Health check",
				security: [],
				responses: { "200": { description: "OK" } },
			},
		},
		"/version": {
			get: {
				tags: ["Meta"],
				summary: "Versão mais recente do app + URL do APK",
				security: [],
				responses: { "200": { description: "Metadados de versão" } },
			},
		},
		"/docs": {
			get: {
				tags: ["Meta"],
				summary: "Esta documentação (Scalar UI)",
				security: [],
				responses: { "200": { description: "HTML — Scalar API Reference" } },
			},
		},
		"/openapi.json": {
			get: {
				tags: ["Meta"],
				summary: "Spec OpenAPI 3.1 desta API",
				security: [],
				responses: {
					"200": {
						description: "JSON",
						content: { "application/json": { schema: { type: "object" } } },
					},
				},
			},
		},
		"/v1/auth/sync": {
			post: {
				tags: ["Auth"],
				summary: "Cria ou reconhece o business do usuário Firebase",
				description:
					"Idempotente. Primeira chamada cria business (slug único = nome-uid) + user " +
					"com trial de 30 dias; seguintes retornam o existente. Chamado pelo app " +
					"logo após o login (Google ou e-mail).",
				responses: {
					"200": { description: "Usuário + business" },
					"401": { description: "Token ausente/inválido" },
				},
			},
		},
		"/v1/me": {
			get: {
				tags: ["Business"],
				summary: "Perfil do business do token",
				responses: {
					"200": { description: "Business + slug + status de assinatura" },
					"401": { description: "Não autenticado" },
				},
			},
			patch: {
				tags: ["Business"],
				summary: "Atualiza perfil (nome, businessType, etc)",
				responses: {
					"200": { description: "Atualizado" },
					"400": { description: "Campo inválido" },
					"402": { description: "Assinatura expirada (paywall)" },
				},
			},
		},
		"/v1/services": {
			get: {
				tags: ["Services"],
				summary: "Lista serviços do prestador",
				responses: { "200": { description: "Array de Service" } },
			},
			post: {
				tags: ["Services"],
				summary: "Cria serviço",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/Service" },
						},
					},
				},
				responses: {
					"201": { description: "Criado" },
					"400": { description: "Validação falhou (preço/duração)" },
					"402": { description: "Paywall" },
				},
			},
		},
		"/v1/services/{id}": {
			get: {
				tags: ["Services"],
				summary: "Detalhe do serviço",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				responses: {
					"200": { description: "Service" },
					"404": { description: "Não encontrado (ou de outro prestador)" },
				},
			},
			patch: {
				tags: ["Services"],
				summary: "Edita serviço",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				requestBody: {
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/Service" },
						},
					},
				},
				responses: {
					"200": { description: "Atualizado" },
					"402": { description: "Paywall" },
					"404": { description: "Não encontrado" },
				},
			},
			delete: {
				tags: ["Services"],
				summary: "Arquiva serviço (soft delete)",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				responses: {
					"200": { description: "Arquivado" },
					"402": { description: "Paywall" },
					"404": { description: "Não encontrado" },
				},
			},
		},
		"/v1/clients": {
			get: {
				tags: ["Clients"],
				summary: "Lista clientes",
				responses: { "200": { description: "Array de Client" } },
			},
			post: {
				tags: ["Clients"],
				summary: "Cria cliente",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/Client" },
						},
					},
				},
				responses: {
					"201": { description: "Criado" },
					"400": { description: "Telefone inválido" },
					"402": { description: "Paywall" },
				},
			},
		},
		"/v1/clients/{id}": {
			get: {
				tags: ["Clients"],
				summary: "Detalhe do cliente",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				responses: {
					"200": { description: "Client" },
					"404": { description: "Não encontrado" },
				},
			},
			patch: {
				tags: ["Clients"],
				summary: "Edita cliente",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				responses: {
					"200": { description: "Atualizado" },
					"404": { description: "Não encontrado" },
				},
			},
			delete: {
				tags: ["Clients"],
				summary: "Remove cliente",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				responses: {
					"200": { description: "Removido" },
					"404": { description: "Não encontrado" },
				},
			},
		},
		"/v1/billing/checkout": {
			post: {
				tags: ["Billing"],
				summary: "Cria assinatura Asaas e retorna URL de pagamento",
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: {
								type: "object",
								required: ["cpf_cnpj"],
								properties: {
									cpf_cnpj: {
										type: "string",
										description: "CPF (11) ou CNPJ (14) do pagador, com ou sem máscara",
									},
								},
							},
						},
					},
				},
				responses: {
					"201": { description: "invoiceUrl do Asaas" },
					"400": { description: "CPF/CNPJ ausente ou inválido" },
					"402": { description: "Paywall" },
					"409": { description: "Já existe assinatura" },
					"503": { description: "Asaas não configurado ou fora do ar" },
				},
			},
		},
		"/webhooks/asaas": {
			post: {
				tags: ["Billing"],
				summary: "Webhook do Asaas (eventos de pagamento/assinatura)",
				description: "Público; autenticado pelo header asaas-access-token. É a única fonte de verdade do subscription_status.",
				parameters: [
					{
						name: "asaas-access-token",
						in: "header",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: { "200": { description: "OK (processado ou ignorado)" }, "401": { description: "Token inválido" } },
			},
		},
		"/v1/appointments": {
			get: {
				tags: ["Appointments"],
				summary: "Agenda por período",
				parameters: [
					{
						name: "from",
						in: "query",
						required: true,
						schema: { type: "string", format: "date-time" },
					},
					{
						name: "to",
						in: "query",
						required: true,
						schema: { type: "string", format: "date-time" },
					},
				],
				responses: { "200": { description: "Array de Appointment" } },
			},
			post: {
				tags: ["Appointments"],
				summary: "Cria agendamento",
				responses: {
					"201": { description: "Criado" },
					"400": { description: "Intervalo inválido ou conflito de horário" },
					"402": { description: "Paywall" },
				},
			},
		},
		"/v1/appointments/{id}": {
			patch: {
				tags: ["Appointments"],
				summary: "Confirma / remarca / cancela / conclui",
				description:
					"Mudanças disparam WhatsApp ao cliente e, se o prestador conectou o " +
					"Google Calendar, espelham o evento (criar/atualizar/remover — RF-08). " +
					"Falha de Calendar NUNCA falha o PATCH (fire-and-forget).",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				responses: {
					"200": { description: "Atualizado" },
					"404": { description: "Não encontrado" },
					"402": { description: "Paywall" },
				},
			},
		},
		"/v1/working-hours": {
			get: {
				tags: ["WorkingHours"],
				summary: "Horário de funcionamento",
				responses: { "200": { description: "WorkingHours map" } },
			},
			put: {
				tags: ["WorkingHours"],
				summary: "Substitui horário de funcionamento",
				responses: {
					"200": { description: "Salvo" },
					"400": { description: "Janela inválida (fim <= início)" },
					"402": { description: "Paywall" },
				},
			},
		},
		"/p/{slug}": {
			get: {
				tags: ["PublicBooking"],
				summary: "Página pública de agendamento",
				security: [],
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: { "200": { description: "HTML — wizard público" } },
			},
		},
		"/p/{slug}/info": {
			get: {
				tags: ["PublicBooking"],
				summary: "Dados públicos do prestador + serviços",
				security: [],
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"200": { description: "Nome, segmento, serviços ativos" },
					"404": { description: "Slug inexistente" },
				},
			},
		},
		"/p/{slug}/busy": {
			get: {
				tags: ["PublicBooking"],
				summary: "Slots ocupados num período",
				security: [],
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "from",
						in: "query",
						required: true,
						schema: { type: "string", format: "date" },
					},
					{
						name: "to",
						in: "query",
						required: true,
						schema: { type: "string", format: "date" },
					},
				],
				responses: { "200": { description: "Intervalos ocupados" } },
			},
		},
		"/p/{slug}/book": {
			post: {
				tags: ["PublicBooking"],
				summary: "Cria agendamento público (status pending)",
				security: [],
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
				],
				responses: {
					"201": { description: "Agendamento criado (pending) + link .ics" },
					"400": { description: "Slot inválido/ocupado" },
					"404": { description: "Slug inexistente" },
					"429": { description: "Rate limit" },
				},
			},
		},
		"/p/{slug}/ics/{appointmentId}": {
			get: {
				tags: ["PublicBooking"],
				summary: "Arquivo .ics do agendamento (adicionar ao calendário)",
				security: [],
				parameters: [
					{
						name: "slug",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "appointmentId",
						in: "path",
						required: true,
						schema: { type: "string", format: "uuid" },
					},
				],
				responses: { "200": { description: "text/calendar" } },
			},
		},
		"/v1/gcal/auth-url": {
			get: {
				tags: ["GCal"],
				summary: "URL de consentimento OAuth do Google Calendar",
				responses: {
					"200": { description: "{ url } — abrir no browser externo" },
					"401": { description: "Não autenticado" },
				},
			},
		},
		"/v1/gcal/callback": {
			get: {
				tags: ["GCal"],
				summary: "Callback OAuth (chamado pelo Google, não pelo dev)",
				security: [],
				description:
					"Troca code por refresh token e salva no business. state = firebaseUid.",
				responses: {
					"302": { description: "Redirect pra página de resultado" },
				},
			},
		},
		"/v1/gcal/status": {
			get: {
				tags: ["GCal"],
				summary: "Prestador conectado ao Google Calendar?",
				responses: { "200": { description: "{ connected: boolean }" } },
			},
		},
		"/v1/gcal": {
			delete: {
				tags: ["GCal"],
				summary: "Desconecta Google Calendar (apaga refresh token)",
				responses: { "200": { description: "Desconectado" } },
			},
		},
	},
} as const;

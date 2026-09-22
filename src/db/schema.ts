/**
 * Schema Drizzle — Minha Agenda (api)
 *
 * Regras de integridade (ver ARCHITECTURE.md):
 * - Overlap de appointments impossível no banco: EXCLUDE USING gist em
 *   tstzrange + business_id (aplica overlaps() do domain/booking.ts no nível SQL)
 * - Money: inteiros em centavos. Nunca float.
 * - Datas: timestamptz. Fuso de negócio America/Sao_Paulo na renderização.
 * - Soft-delete em clients (deleted_at); purge real via endpoint LGPD.
 *
 * Auth (BD-01, 09/09): Firebase Authentication. users.guarda firebase_uid —
 * a API valida o ID token do Firebase e resolve o user por firebase_uid.
 */

import { sql } from "drizzle-orm";
import {
	boolean,
	customType,
	date,
	index,
	integer,
	pgEnum,
	pgTable,
	serial,
	text,
	time,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", ["owner", "pro", "reception"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
	"pending",
	"confirmed",
	"done",
	"canceled",
	"noshow",
]);
export const appointmentSourceEnum = pgEnum("appointment_source", [
	"app",
	"public_link",
	// RF-A: bloqueio de horário do prestador (compromisso externo).
	// Ocupa slot como qualquer agendamento ativo; cancelar libera.
	"block",
]);
export const transactionTypeEnum = pgEnum("transaction_type", [
	"income",
	"expense",
]);
export const messageTemplateKindEnum = pgEnum("message_template_kind", [
	"reminder",
	"confirm",
	"birthday",
	"custom",
]);

export const waitlistStatusEnum = pgEnum("waitlist_status", [
	"waiting",
	"notified",
	"served",
]);
export const businesses = pgTable("businesses", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: varchar("name", { length: 120 }).notNull(),
	slug: varchar("slug", { length: 80 }).notNull().unique(),
	/** Segmento do negócio: beauty, barber, dental, medical, auto_detailing,
	 *  pet_grooming, veterinary, mechanic, other. Define preset visual/serviços no app. */
	businessType: varchar("business_type", { length: 30 })
		.notNull()
		.default("beauty"),
	timezone: varchar("timezone", { length: 40 })
		.notNull()
		.default("America/Sao_Paulo"),
	subscriptionStatus: varchar("subscription_status", { length: 20 })
		.notNull()
		.default("trial"),
	trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
	// RF-08: Google Calendar do business (refresh token OAuth, 1 prof/MVP)
	gcalRefreshToken: text("gcal_refresh_token"),
	gcalConnectedAt: timestamp("gcal_connected_at", { withTimezone: true }),
	logoData: customType<{ data: Buffer; driverData: Buffer }>({
		dataType() {
			return "bytea";
		},
	})("logo_data"),
	logoMime: varchar("logo_mime", { length: 40 }),
	logoUpdatedAt: timestamp("logo_updated_at", { withTimezone: true }),
	// B15: add-on WhatsApp Pro (Cloud API da Meta) — flag OFF por default;
	// base grátis (wa.me deep link) não depende destes campos.
	whatsappProEnabled: boolean("whatsapp_pro_enabled").notNull().default(false),
	whatsappPhoneNumberId: varchar("whatsapp_phone_number_id", { length: 64 }),
	trialReminderSentAt: timestamp("trial_reminder_sent_at", {
		withTimezone: true,
	}),
	// Billing Asaas (RF-14): ids de integração. NULL = nunca assinou.
	// O webhook (Fase B) usa asaas_customer_id pra achar o business.
	asaasCustomerId: varchar("asaas_customer_id", { length: 64 }),
	asaasSubscriptionId: varchar("asaas_subscription_id", { length: 64 }),
	// Endereço (F1, migration 0013): onde o atendimento acontece — mostrado
	// na página pública de booking. Campos separados pra futura integração
	// com mapas/rota. Todos opcionais (business online/externo não tem).
	addressStreet: varchar("address_street", { length: 200 }),
	addressNumber: varchar("address_number", { length: 20 }),
	addressDistrict: varchar("address_district", { length: 80 }),
	addressCity: varchar("address_city", { length: 80 }),
	addressState: varchar("address_state", { length: 2 }),
	addressZip: varchar("address_zip", { length: 9 }),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const users = pgTable(
	"users",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		businessId: uuid("business_id")
			.notNull()
			.references(() => businesses.id),
		// Auth Firebase: uid imutável do Firebase Auth (email/senha ou Google)
		firebaseUid: varchar("firebase_uid", { length: 128 }).notNull().unique(),
		email: varchar("email", { length: 200 }).notNull(),
		name: varchar("name", { length: 120 }).notNull(),
		phone: varchar("phone", { length: 20 }),
		role: userRoleEnum("role").notNull().default("owner"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("users_business_idx").on(t.businessId)],
);

export const services = pgTable(
	"services",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		businessId: uuid("business_id")
			.notNull()
			.references(() => businesses.id),
		name: varchar("name", { length: 120 }).notNull(),
		durationMin: integer("duration_min").notNull(),
		priceCents: integer("price_cents").notNull(),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("services_business_idx").on(t.businessId)],
);

export const clients = pgTable(
	"clients",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		businessId: uuid("business_id")
			.notNull()
			.references(() => businesses.id),
		name: varchar("name", { length: 120 }).notNull(),
		phoneE164: varchar("phone_e164", { length: 20 }).notNull(),
		email: varchar("email", { length: 200 }),
		birthday: date("birthday"),
		notes: text("notes"),
		// Soft-delete (LGPD: purge real via endpoint dedicado)
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("clients_business_phone_idx").on(t.businessId, t.phoneE164)],
);

export const workingHours = pgTable(
	"working_hours",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id),
		weekday: integer("weekday").notNull(), // 0=dom .. 6=sáb
		startTime: time("start_time").notNull(),
		endTime: time("end_time").notNull(),
	},
	(t) => [index("working_hours_user_idx").on(t.userId, t.weekday)],
);

export const appointments = pgTable(
	"appointments",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		businessId: uuid("business_id")
			.notNull()
			.references(() => businesses.id),
		clientId: uuid("client_id")
			.notNull()
			.references(() => clients.id),
		serviceId: uuid("service_id")
			.notNull()
			.references(() => services.id),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id),
		startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
		endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
		status: appointmentStatusEnum("status").notNull().default("pending"),
		source: appointmentSourceEnum("source").notNull().default("app"),
		canceledReason: text("canceled_reason"),
		canceledAt: timestamp("canceled_at", { withTimezone: true }),
		// F2 (migration 0014): push de lembrete já enviado (idempotência do job)
		reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
		// RF-08: id do evento espelhado no Google Calendar do business
		gcalEventId: text("gcal_event_id"),
		createdByUserId: uuid("created_by_user_id").references(() => users.id),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		index("appointments_business_start_idx").on(t.businessId, t.startsAt),
		// NÚCLEO DO NEGÓCIO: impossível sobrepor agendamentos ativos do mesmo
		// profissional no mesmo business. Cancelado/noshow liberam o slot.
		uniqueIndex("appointments_no_overlap_idx")
			.on(t.businessId, t.userId, sql`tstzrange(${t.startsAt}, ${t.endsAt})`)
			.where(sql`status IN ('pending', 'confirmed')`),
	],
);

export const transactions = pgTable(
	"transactions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		businessId: uuid("business_id")
			.notNull()
			.references(() => businesses.id),
		type: transactionTypeEnum("type").notNull(),
		amountCents: integer("amount_cents").notNull(),
		category: varchar("category", { length: 60 }).notNull(),
		appointmentId: uuid("appointment_id").references(() => appointments.id),
		occurredAt: timestamp("occurred_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		notes: text("notes"),
	},
	(t) => [
		index("transactions_business_occurred_idx").on(t.businessId, t.occurredAt),
	],
);

export const loyaltyPrograms = pgTable("loyalty_programs", {
	id: uuid("id").defaultRandom().primaryKey(),
	businessId: uuid("business_id")
		.notNull()
		.references(() => businesses.id),
	serviceId: uuid("service_id")
		.notNull()
		.references(() => services.id),
	visitsRequired: integer("visits_required").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const loyaltyCards = pgTable(
	"loyalty_cards",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		programId: uuid("program_id")
			.notNull()
			.references(() => loyaltyPrograms.id),
		clientId: uuid("client_id")
			.notNull()
			.references(() => clients.id),
		visits: integer("visits").notNull().default(0),
	},
	(t) => [
		uniqueIndex("loyalty_cards_program_client_uq").on(t.programId, t.clientId),
	],
);

export const messageTemplates = pgTable("message_templates", {
	id: uuid("id").defaultRandom().primaryKey(),
	businessId: uuid("business_id")
		.notNull()
		.references(() => businesses.id),
	kind: messageTemplateKindEnum("kind").notNull(),
	body: text("body").notNull(),
});

export const subscriptions = pgTable("subscriptions", {
	id: uuid("id").defaultRandom().primaryKey(),
	businessId: uuid("business_id")
		.notNull()
		.references(() => businesses.id),
	platform: varchar("platform", { length: 20 }).notNull(), // play | stripe
	externalId: varchar("external_id", { length: 200 }).notNull(),
	status: varchar("status", { length: 20 }).notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }),
});

/**
 * Extensões 2026-09-16 (migrations 0005/0006):
 * logo do estabelecimento, lembrete de trial e tokens FCM por device.
 */
export const businessesWithLogo = businesses;

/**
 * F5 (migration 0016): lista de espera — cliente deixa whatsapp e o dia
 * desejado; quando o prestador cancela, a rota de cancelamento consulta
 * quem espera por aquele dia e notifica (push/WhatsApp).
 */
export const waitlist = pgTable(
	"waitlist",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		businessId: uuid("business_id")
			.notNull()
			.references(() => businesses.id, { onDelete: "cascade" }),
		clientId: uuid("client_id")
			.notNull()
			.references(() => clients.id, { onDelete: "cascade" }),
		desiredDate: date("desired_date").notNull(),
		phoneE164: varchar("phone_e164", { length: 20 }).notNull(),
		status: waitlistStatusEnum("status").notNull().default("waiting"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("waitlist_date_idx").on(t.desiredDate, t.status)],
);

/**
 * F3 (migration 0015): bloqueios de agenda — almoço, feriado, férias.
 * Janela em que o profissional não aceita agendamentos mesmo dentro
 * do expediente. Slots públicos consultam esta tabela via NOT EXISTS.
 */
export const timeOffs = pgTable(
	"time_offs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		businessId: uuid("business_id")
			.notNull()
			.references(() => businesses.id, { onDelete: "cascade" }),
		reason: varchar("reason", { length: 120 }),
		startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
		endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		index("time_offs_user_start_idx").on(t.userId, t.startsAt),
		sql`CONSTRAINT time_offs_range_ck CHECK (ends_at > starts_at)`,
	],
);

export const deviceTokens = pgTable("device_tokens", {
	id: uuid("id").defaultRandom().primaryKey(),
	userId: uuid("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	fcmToken: text("fcm_token").notNull().unique(),
	platform: varchar("platform", { length: 10 }).notNull(), // android | ios
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

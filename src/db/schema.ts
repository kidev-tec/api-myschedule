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
	date,
	index,
	integer,
	pgEnum,
	pgTable,
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

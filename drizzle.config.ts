import { defineConfig } from "drizzle-kit";

// Migrações: drizzle-kit generate (SQL em ./drizzle), apply via migrate() no boot
// ou `drizzle-kit push` em dev. DATABASE_URL vem do .env (nunca commitar).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/minha_agenda_dev",
  },
  strict: true,
  verbose: true,
});

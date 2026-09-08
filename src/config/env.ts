// RF-01: validação de env no boot — fail fast com Zod (padrão piano-api)
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "obrigatória (postgres://...)"),
  CORS_ORIGINS: z.string().default("*"),
  JWT_SECRET: z.string().min(32, "mínimo 32 caracteres"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Valida variáveis de ambiente. Recebe um objeto (injetável para testes).
 * Lança com mensagem clara indicando qual variável está inválida.
 */
export function validateEnv(
  raw: Record<string, string | undefined>,
): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new Error(
      `Env inválida: ${path} — ${issue?.message}. Corrija o .env e reinicie.`,
    );
  }
  return parsed.data;
}

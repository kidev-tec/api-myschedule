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
  // Auth = Firebase (Rafael, 09/09): a API valida o ID token emitido pelo
  // Firebase Auth (email/senha + Google OAuth). Sem JWT próprio.
  FIREBASE_PROJECT_ID: z.string().min(1, "obrigatória (project id do Firebase)"),
  // Credenciais de serviço do Firebase (firebase-admin): JSON completo no env
  // (FIREBASE_SERVICE_ACCOUNT_B64 = base64 do service account JSON) — NUNCA commitar.
  FIREBASE_SERVICE_ACCOUNT_B64: z.string().optional(),
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

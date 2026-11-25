-- 0027_platform_admin — role platform_admin, suspensão de tenant,
-- admin_audit_log append-only (SPEC-admin RF-A1/A2/A3/A6).

ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'platform_admin';

ALTER TABLE "businesses"
  ADD COLUMN IF NOT EXISTS "is_platform_internal" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "suspended_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "suspended_by_user_id" uuid REFERENCES "users"("id"),
  ADD COLUMN IF NOT EXISTS "suspension_reason" text;

CREATE INDEX IF NOT EXISTS "businesses_admin_list_idx"
  ON "businesses" ("created_at" DESC, "id")
  WHERE "is_platform_internal" = false;
CREATE INDEX IF NOT EXISTS "businesses_suspended_idx"
  ON "businesses" ("suspended_at")
  WHERE "suspended_at" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "who_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "what" varchar(80) NOT NULL,
  "target_type" varchar(40) NOT NULL,
  "target_id" uuid NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "ip" varchar(64) NOT NULL
);
CREATE INDEX IF NOT EXISTS "admin_audit_log_occurred_idx"
  ON "admin_audit_log" ("occurred_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "admin_audit_log_target_idx"
  ON "admin_audit_log" ("target_type", "target_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "admin_audit_log_who_idx"
  ON "admin_audit_log" ("who_user_id", "occurred_at" DESC);

CREATE OR REPLACE FUNCTION prevent_admin_audit_log_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only';
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'admin_audit_log_append_only'
  ) THEN
    CREATE TRIGGER admin_audit_log_append_only
    BEFORE UPDATE OR DELETE ON "admin_audit_log"
    FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_log_mutation();
  END IF;
END;
$$;

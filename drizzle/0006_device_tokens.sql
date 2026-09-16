-- 0006: tokens FCM por device (push). Token é UNIQUE: reinstall substitui
-- o dono (upsert por fcm_token no INSERT ... ON CONFLICT).
CREATE TABLE IF NOT EXISTS device_tokens (
  id serial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token text NOT NULL UNIQUE,
  platform varchar(10) NOT NULL CHECK (platform IN ('android', 'ios')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

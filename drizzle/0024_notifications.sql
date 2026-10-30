-- 0024: central de notificações do app. Todo push que a API manda pro
-- prestador também fica guardado aqui (sino + lista no app), com o tipo e
-- os dados pra abrir o agendamento. read_at NULL = não lida.
CREATE TABLE IF NOT EXISTS notifications (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        varchar(30) NOT NULL,
  title       varchar(200) NOT NULL,
  body        text        NOT NULL DEFAULT '',
  data        jsonb,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- lista do usuário, mais novas primeiro + contagem de não lidas
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
  ON notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;

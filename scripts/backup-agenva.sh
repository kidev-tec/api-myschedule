#!/usr/bin/env bash
# Backup diário do Postgres de PRODUÇÃO da AGENVA (Supabase remoto) — RF-D2 / PLAN-devops v1.1.0
# Instalação na VM (root):
#   install -m 700 backup-agenva.sh /opt/backups/agenva/backup-agenva.sh
#   echo 'DATABASE_URL="postgres://...PROD..." DIRECT_URL="postgres://...PROD..." ' > /opt/backups/agenva/.pgpass-env  # chmod 600
#   crontab -e:  0 3 * * * /opt/backups/agenva/backup-agenva.sh >> /var/log/agenva-backup.log 2>&1
# Retenção: 30 dias. Restore: sempre em banco DESCARTÁVEL, nunca sobre banco ativo.
set -euo pipefail

BACKUP_DIR="/opt/backups/agenva"
RETENTION_DAYS=30
ENV_FILE="${BACKUP_DIR}/.pgpass-env" # contém DATABASE_URL (pooler p/ apps) e DIRECT_URL (conexão direta p/ pg_dump)
STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="${BACKUP_DIR}/agenva_prod_${STAMP}.sql.gz"

# shellcheck disable=SC1090
source "${ENV_FILE}"

mkdir -p "${BACKUP_DIR}"

# Preferir DIRECT_URL (conexão direta, suporta pg_dump completo); fallback DATABASE_URL (pooler)
CONN="${DIRECT_URL:-${DATABASE_URL}}"
if [ -z "${CONN}" ]; then
  echo "[agenva-backup] ERRO: sem DATABASE_URL/DIRECT_URL em ${ENV_FILE}" >&2
  exit 1
fi

echo "[agenva-backup] dump iniciado ${STAMP}"
pg_dump --no-owner --no-privileges --dbname "${CONN}" | gzip > "${OUT}"

# Verificação de integridade: arquivo não-vazio E legível por pg_restore --list
if [ ! -s "${OUT}" ]; then
  echo "[agenva-backup] ERRO: dump vazio" >&2
  rm -f "${OUT}"
  exit 1
fi
if ! gzip -t "${OUT}"; then
  echo "[agenva-backup] ERRO: gzip corrompido" >&2
  rm -f "${OUT}"
  exit 1
fi
pg_restore --list "${OUT}" > /dev/null 2>&1 || {
  echo "[agenva-backup] ERRO: pg_restore não conseguiu ler o dump" >&2
  exit 1
}

SIZE=$(du -h "${OUT}" | cut -f1)
echo "[agenva-backup] OK ${OUT} (${SIZE})"

# Retenção 30 dias
find "${BACKUP_DIR}" -name "agenva_prod_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
echo "[agenva-backup] retenção aplicada (${RETENTION_DAYS}d)"

# api-myschedule

## Backup & Restore (operacional)

- **Automático**: cron `30 4 * * *` roda `~/run/backup-minha-agenda.sh` → dump `pg_dump -Fc` do Supabase (prod) e do Postgres dev (docker) → `~/backups/minha-agenda/` + cópia `rclone` → OneDrive (`backups/minha-agenda/`). Retenção local de 30 dias. Log: `~/run/logs/backup.log`. O script valida que o dump do dia é restaurável (`pg_restore --list`).
- **Manual**: `bash ~/run/backup-minha-agenda.sh`
- **Restaurar** (usar Postgres **17** — versão do Supabase):

```bash
# 1. subir um postgres 17 descartável com o dump montado
docker run --rm -v ~/backups/minha-agenda:/bk:ro -it postgres:17-alpine bash
# 2. dentro do container (ou numa base scratch qualquer):
createdb -U postgres restore_test
pg_restore -U postgres -d restore_test --no-owner --no-privileges /bk/prod_YYYYMMDD_HHMMSS.dump
# 3. conferir schema e dados:
psql -U postgres -d restore_test -c '\dt'
```

- **Conferir cópia no OneDrive**: `rclone lsl onedrive:backups/minha-agenda/ | tail -5`
- **Importante**: dumps gerados por pg_dump 17 não restauram em Postgres ≤ 16 ("unsupported version (1.16)").

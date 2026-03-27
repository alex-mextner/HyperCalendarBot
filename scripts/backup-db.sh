#!/bin/bash
# Daily SQLite backup via VACUUM INTO — safe for WAL-mode databases.
# Cron: 0 3 * * * /opt/hypercal/scripts/backup-db.sh >> /opt/hypercal/logs/backup.log 2>&1

set -euo pipefail

DATA_DIR="/opt/hypercal/data"
BACKUP_DIR="${DATA_DIR}/backups"
KEEP_DAYS=14

mkdir -p "${BACKUP_DIR}"

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)

# Safe WAL-mode backup via VACUUM INTO
docker compose --project-directory /opt/hypercal -f /opt/hypercal/docker-compose.yml exec -T bot \
  bun -e "const d = new (await import(\"bun:sqlite\")).Database(\"/app/data/calendar.db\",{readonly:true}); d.exec(\"VACUUM INTO '/app/data/backups/calendar_${TIMESTAMP}.db'\"); d.close();"

BACKUP_FILE="${BACKUP_DIR}/calendar_${TIMESTAMP}.db"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file not created" >&2
  exit 1
fi

gzip "${BACKUP_FILE}"
SIZE=$(du -h "${BACKUP_DIR}/calendar_${TIMESTAMP}.db.gz" | cut -f1)
echo "Backup OK: calendar_${TIMESTAMP}.db.gz (${SIZE})"

# Cleanup old backups
find "${BACKUP_DIR}" -name "calendar_*.db.gz" -mtime +${KEEP_DAYS} -delete

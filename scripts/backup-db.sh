#!/bin/bash
# Daily SQLite backup via VACUUM INTO — safe for WAL-mode databases.
# Cron (root): 0 3 * * * /opt/hypercal/scripts/backup-db.sh >> /opt/hypercal/logs/backup.log 2>&1
# Also run by the deploy before it replaces the container. Runs as root: the copies it
# restricts belong to the container user.
#
# A backup holds every user's chats, calendars and Telegram sessions on a host shared
# with other services (GH-613): files are 0600 and the directory 0700. The copy is
# written inside the bot container (uid 999, umask 022), so the host umask alone does
# not cover it; the container snippet sets its own umask and the host enforces and
# verifies the final modes, deleting a copy it cannot restrict.

set -euo pipefail
umask 077

DATA_DIR="/opt/hypercal/data"
BACKUP_DIR="${DATA_DIR}/backups"
KEEP_DAYS=14

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="${BACKUP_DIR}/calendar_${TIMESTAMP}.db"
ARCHIVE="${BACKUP_FILE}.gz"

mode_of() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

discard() {
  rm -f "${BACKUP_FILE}" "${ARCHIVE}"
  echo "ERROR: $1" >&2
  exit 1
}

# The container user creates the directory, so the bot can still write into it.
# Safe WAL-mode backup via VACUUM INTO.
docker compose --project-directory /opt/hypercal -f /opt/hypercal/docker-compose.yml exec -T bot \
  bun -e "process.umask(0o077);
(await import('node:fs')).mkdirSync('/app/data/backups', { recursive: true, mode: 0o700 });
const d = new (await import('bun:sqlite')).Database('/app/data/calendar.db', { readonly: true });
d.exec(\"VACUUM INTO '/app/data/backups/calendar_${TIMESTAMP}.db'\");
d.close();"

if [ ! -f "${BACKUP_FILE}" ]; then
  echo "ERROR: Backup file not created" >&2
  exit 1
fi

chmod 700 "${BACKUP_DIR}" || discard "cannot restrict ${BACKUP_DIR} to 0700"
chmod 600 "${BACKUP_FILE}" || discard "cannot restrict ${BACKUP_FILE} to 0600"
gzip "${BACKUP_FILE}" || discard "gzip failed"
chmod 600 "${ARCHIVE}" || discard "cannot restrict ${ARCHIVE} to 0600"
dir_mode="$(mode_of "${BACKUP_DIR}")" || true
[[ "${dir_mode}" == 700 ]] || discard "${BACKUP_DIR} is mode ${dir_mode:-unknown}, expected 700"
archive_mode="$(mode_of "${ARCHIVE}")" || true
[[ "${archive_mode}" == 600 ]] || discard "${ARCHIVE} is mode ${archive_mode:-unknown}, expected 600"

# Cleanup old backups (and any uncompressed copy a killed run left before its gzip)
find "${BACKUP_DIR}" -maxdepth 1 -name "calendar_*.db*" -mtime +${KEEP_DAYS} -delete

# Copies written before GH-613 (or by a deploy still running the previous script) were 0644;
# this covers both our calendar_<timestamp>.db.gz and the bot's calendar-<date>.db copies.
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'calendar*' ! -perm 600 -exec chmod 600 {} +

SIZE=$(du -h "${ARCHIVE}" | cut -f1)
echo "Backup OK: calendar_${TIMESTAMP}.db.gz (${SIZE}, mode 600)"

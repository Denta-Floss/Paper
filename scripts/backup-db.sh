#!/usr/bin/env bash
# A hot backup of the Paper database: a consistent copy while the server keeps
# running (SQLite VACUUM INTO on its own connection, then integrity_check;
# backend/kernel/backup.js), plus paper-latest.db and, when
# PAPER_S3_BUCKET_NAME is set, an upload of both to S3.
#
#   DB_PATH=/srv/paper/paper.db scripts/backup-db.sh
#   (PAPER_BACKUP_DIR, PAPER_BACKUP_KEEP=14, PAPER_S3_BUCKET_NAME, PAPER_CLIENT_ID)
#
# Cron, daily at 02:30:
#   30 2 * * * DB_PATH=/srv/paper/paper.db /srv/paper/scripts/backup-db.sh >> /var/log/paper-backup.log 2>&1
#
# Restore (server stopped): DB_PATH=... node backend/scripts/restore-sqlite.js <backup.db>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
exec node "$here/../backend/scripts/backup-sqlite.js" "$@"

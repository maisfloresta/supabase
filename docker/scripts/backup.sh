#!/bin/bash
# Supabase PostgreSQL backup script
# Schedule via crontab: 0 3 * * * /opt/supabase/docker/scripts/backup.sh
set -euo pipefail

BACKUP_DIR="/opt/supabase/docker/volumes/backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/supabase_${TIMESTAMP}.dump"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting backup..."

docker exec supabase-db pg_dump \
  -U postgres \
  -Fc \
  --no-owner \
  --no-privileges \
  postgres > "$BACKUP_FILE"

FILESIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null)
echo "[$(date)] Backup created: $BACKUP_FILE ($FILESIZE bytes)"

# Remove backups older than retention period
DELETED=$(find "$BACKUP_DIR" -name "*.dump" -mtime +$RETENTION_DAYS -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date)] Cleaned up $DELETED old backup(s)"
fi

echo "[$(date)] Backup complete"

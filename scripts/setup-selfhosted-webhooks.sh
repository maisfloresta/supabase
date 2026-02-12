#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/docker/.env"
COMPOSE_FILE="$ROOT_DIR/docker/docker-compose.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Arquivo não encontrado: $ENV_FILE" >&2
  exit 1
fi

read_env() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  echo "${line#*=}"
}

write_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i -E "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

gen_token() {
  openssl rand -hex 24
}

YAMPI_WEBHOOK_SECRET="$(read_env YAMPI_WEBHOOK_SECRET)"
CARTPANDA_WEBHOOK_SECRET="$(read_env CARTPANDA_WEBHOOK_SECRET)"
WEBHOOK_SHARED_TOKEN="$(read_env WEBHOOK_SHARED_TOKEN)"
API_EXTERNAL_URL="$(read_env API_EXTERNAL_URL)"

if [[ -z "$YAMPI_WEBHOOK_SECRET" ]]; then
  YAMPI_WEBHOOK_SECRET="$(gen_token)"
  write_env YAMPI_WEBHOOK_SECRET "$YAMPI_WEBHOOK_SECRET"
fi

if [[ -z "$CARTPANDA_WEBHOOK_SECRET" ]]; then
  CARTPANDA_WEBHOOK_SECRET="$(gen_token)"
  write_env CARTPANDA_WEBHOOK_SECRET "$CARTPANDA_WEBHOOK_SECRET"
fi

if [[ -z "$WEBHOOK_SHARED_TOKEN" ]]; then
  WEBHOOK_SHARED_TOKEN="$(gen_token)"
  write_env WEBHOOK_SHARED_TOKEN "$WEBHOOK_SHARED_TOKEN"
fi

if [[ -z "$API_EXTERNAL_URL" ]]; then
  API_EXTERNAL_URL="$(read_env SUPABASE_PUBLIC_URL)"
fi

if [[ -z "$API_EXTERNAL_URL" ]]; then
  echo "Defina API_EXTERNAL_URL (ou SUPABASE_PUBLIC_URL) em docker/.env" >&2
  exit 1
fi

API_EXTERNAL_URL="${API_EXTERNAL_URL%/}"

# Reinicia apenas o runtime de funções para carregar variáveis atualizadas.
docker compose -f "$COMPOSE_FILE" up -d --no-deps functions >/dev/null

# Mantém o token interno sincronizado para pg_cron -> jobs-runner.
POSTGRES_PASSWORD="$(read_env POSTGRES_PASSWORD)"
if [[ -n "$POSTGRES_PASSWORD" ]]; then
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" -i supabase-db psql -h localhost -U supabase_admin -d postgres <<SQL >/dev/null
alter database postgres set app.settings.webhook_shared_token = '${WEBHOOK_SHARED_TOKEN}';
SQL
else
  echo "Aviso: POSTGRES_PASSWORD ausente em docker/.env; não foi possível sincronizar app.settings.webhook_shared_token" >&2
fi

echo "Webhooks prontos. Use estas URLs nos provedores:"
echo "Yampi:     ${API_EXTERNAL_URL}/functions/v1/webhook-yampi?token=${YAMPI_WEBHOOK_SECRET}"
echo "CartPanda: ${API_EXTERNAL_URL}/functions/v1/webhook-cartpanda?token=${CARTPANDA_WEBHOOK_SECRET}"

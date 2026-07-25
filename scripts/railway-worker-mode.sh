#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="${RAILWAY_ENVIRONMENT:-production}"
WEB_SERVICE="${RLM_WIKI_WEB_SERVICE:-selfless-fulfillment}"
WORKER_SERVICE="${RLM_WIKI_WORKER_SERVICE:-selfless-worker}"
HEALTH_URL="${RLM_WIKI_HEALTH_URL:-https://selfless-fulfillment-production-1d9b.up.railway.app/api/health}"
WORKER_ID="${RLM_WIKI_WORKER_ID:-railway-prod-worker-1}"

usage() {
  cat <<EOF
Usage: $0 <command>

Commands:
  status          Show Railway services, safe web vars, and app health.
  deploy-worker   Create/configure the worker service and deploy this repo to it.
  enable          Deploy worker if needed, then switch web to RLM_WIKI_RUN_MODE=worker.
  disable         Switch web back to inline and stop the latest worker deployment.
  revert          Alias for disable.

Environment overrides:
  RAILWAY_ENVIRONMENT     default: production
  RLM_WIKI_WEB_SERVICE    default: selfless-fulfillment
  RLM_WIKI_WORKER_SERVICE default: selfless-worker
  RLM_WIKI_HEALTH_URL     default: ${HEALTH_URL}
EOF
}

need_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

require_tools() {
  need_tool railway
  need_tool node
  need_tool curl
}

service_exists() {
  local service="$1"
  railway status --json | node -e '
const service = process.argv[1];
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const status = JSON.parse(input);
  const services = status.services?.edges || [];
  process.exit(services.some((edge) => edge.node?.name === service || edge.node?.id === service) ? 0 : 1);
});
' "$service"
}

safe_vars() {
  local service="$1"
  railway variable list --service "$service" --environment "$ENVIRONMENT" --json | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const vars = JSON.parse(input || "{}");
  console.log(JSON.stringify({
    RLM_WIKI_PROCESS: vars.RLM_WIKI_PROCESS || null,
    RLM_WIKI_RUN_MODE: vars.RLM_WIKI_RUN_MODE || null,
    hasDatabaseUrl: Boolean(vars.DATABASE_URL),
    hasSecretGrantKey: Boolean(vars.RLM_WIKI_SECRET_GRANT_KEY),
  }, null, 2));
});
'
}

copy_web_secret_grant_key_to_worker() {
  local grant_key
  grant_key="$(railway variable list --service "$WEB_SERVICE" --environment "$ENVIRONMENT" --json | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const vars = JSON.parse(input || "{}");
  if (!vars.RLM_WIKI_SECRET_GRANT_KEY) process.exit(2);
  process.stdout.write(vars.RLM_WIKI_SECRET_GRANT_KEY);
});
')"
  printf '%s' "$grant_key" | railway variable set --service "$WORKER_SERVICE" --environment "$ENVIRONMENT" --skip-deploys --stdin RLM_WIKI_SECRET_GRANT_KEY >/dev/null
}

configure_worker() {
  railway variable set \
    --service "$WORKER_SERVICE" \
    --environment "$ENVIRONMENT" \
    --skip-deploys \
    RLM_WIKI_PROCESS=worker \
    RLM_WIKI_ROOT=/tmp/rlm-wiki-worker \
    RLM_WIKI_WORKER_ID="$WORKER_ID" \
    'DATABASE_URL=${{Postgres.DATABASE_URL}}' >/dev/null

  if ! copy_web_secret_grant_key_to_worker; then
    echo "Could not copy RLM_WIKI_SECRET_GRANT_KEY from ${WEB_SERVICE}; configure it on web first." >&2
    exit 1
  fi
}

wait_for_service_success() {
  local service="$1"
  local attempts="${2:-90}"
  for _ in $(seq 1 "$attempts"); do
    set +e
    railway status --json | node -e '
const service = process.argv[1];
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const status = JSON.parse(input);
  const env = status.environments?.edges?.[0]?.node;
  const match = (env?.serviceInstances?.edges || []).find((edge) => edge.node?.serviceName === service || edge.node?.serviceId === service);
  const deployment = match?.node?.latestDeployment;
  if (!deployment) process.exit(2);
  console.log(JSON.stringify({
    service,
    id: deployment.id,
    status: deployment.status,
    instances: (deployment.instances || []).map((instance) => instance.status),
  }));
  process.exit(deployment.status === "SUCCESS" ? 0 : deployment.status === "FAILED" || deployment.status === "CRASHED" ? 1 : 2);
});
' "$service"
    local code="$?"
    set -e
    if [ "$code" = "0" ]; then
      return 0
    fi
    if [ "$code" = "1" ]; then
      return 1
    fi
    sleep 5
  done
  return 1
}

show_health() {
  curl -fsS "$HEALTH_URL" | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const h = JSON.parse(input);
  console.log(JSON.stringify({
    ok: h.ok,
    persistence: h.persistence,
    productStore: h.storage?.productStore,
    localDiskRole: h.storage?.localDiskRole,
    queue: h.queue,
    secretGrants: h.secretGrants,
    runMode: h.runMode,
    authMode: h.authMode,
  }, null, 2));
});
'
}

apply_web_env() {
  railway redeploy --service "$WEB_SERVICE" --yes --json >/dev/null
  wait_for_service_success "$WEB_SERVICE"
}

status() {
  echo "Services:"
  railway service list --environment "$ENVIRONMENT"
  echo
  echo "Web safe vars:"
  safe_vars "$WEB_SERVICE"
  if service_exists "$WORKER_SERVICE"; then
    echo
    echo "Worker safe vars:"
    safe_vars "$WORKER_SERVICE"
  fi
  echo
  echo "Health:"
  show_health
}

deploy_worker() {
  if ! service_exists "$WORKER_SERVICE"; then
    echo "Creating Railway worker service: ${WORKER_SERVICE}"
    railway add --service "$WORKER_SERVICE" --json >/dev/null
  fi
  echo "Configuring worker service variables."
  configure_worker
  echo "Deploying worker service."
  railway up --service "$WORKER_SERVICE" --environment "$ENVIRONMENT" --detach --message "Worker mode rehearsal lane"
  wait_for_service_success "$WORKER_SERVICE"
}

enable() {
  deploy_worker
  echo "Switching web service to worker mode."
  railway variable set --service "$WEB_SERVICE" --environment "$ENVIRONMENT" --skip-deploys RLM_WIKI_RUN_MODE=worker >/dev/null
  apply_web_env
  show_health
}

disable() {
  echo "Switching web service back to inline mode."
  railway variable set --service "$WEB_SERVICE" --environment "$ENVIRONMENT" --skip-deploys RLM_WIKI_RUN_MODE=inline >/dev/null
  apply_web_env

  if service_exists "$WORKER_SERVICE"; then
    echo "Stopping latest worker deployment."
    railway down --service "$WORKER_SERVICE" --environment "$ENVIRONMENT" --yes >/dev/null || true
  fi
  show_health
}

main() {
  require_tools
  case "${1:-}" in
    status) status ;;
    deploy-worker) deploy_worker ;;
    enable) enable ;;
    disable|revert) disable ;;
    -h|--help|help|"") usage ;;
    *)
      echo "Unknown command: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
}

main "$@"

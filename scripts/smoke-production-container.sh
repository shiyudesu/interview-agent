#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="interview-agent-smoke-$$"
NETWORK="${PROJECT}_default"
IMAGE_TAG="interview-agent-smoke:$$"
APP_CONTAINER="${PROJECT}-app"
DATABASE_URL_CONTAINER="postgresql://interview:interview@postgres:5432/interview"
BETTER_AUTH_SECRET="production-smoke-auth-secret-32-bytes"
MODEL_API_KEY="production-smoke-model-key"
SMOKE_EMAIL="production-smoke@example.test"

ROOT_HEADERS="$(mktemp /tmp/interview-agent-smoke-root-headers.XXXXXX)"
ROOT_BODY="$(mktemp /tmp/interview-agent-smoke-root-body.XXXXXX)"
RESPONSE_HEADERS="$(mktemp /tmp/interview-agent-smoke-response-headers.XXXXXX)"
RESPONSE_BODY="$(mktemp /tmp/interview-agent-smoke-response-body.XXXXXX)"

cleanup() {
  docker rm --force "$APP_CONTAINER" >/dev/null 2>&1 || true
  if [[ -n "${POSTGRES_PORT:-}" ]]; then
    POSTGRES_PORT="$POSTGRES_PORT" \
      MAILPIT_SMTP_PORT="$MAILPIT_SMTP_PORT" \
      MAILPIT_UI_PORT="$MAILPIT_UI_PORT" \
      docker compose --project-name "$PROJECT" --file "$ROOT_DIR/compose.yaml" \
        down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  docker image rm "$IMAGE_TAG" >/dev/null 2>&1 || true
  rm -f "$ROOT_HEADERS" "$ROOT_BODY" "$RESPONSE_HEADERS" "$RESPONSE_BODY"
}
trap cleanup EXIT

read -r POSTGRES_PORT MAILPIT_SMTP_PORT MAILPIT_UI_PORT APP_PORT < <(
  node --input-type=module - <<'NODE'
import net from "node:net";

const servers = [];
for (let index = 0; index < 4; index += 1) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
}
console.log(
  servers
    .map((server) => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error("Could not allocate smoke-test ports");
      }
      return address.port;
    })
    .join(" "),
);
await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
NODE
)

cd "$ROOT_DIR"

POSTGRES_PORT="$POSTGRES_PORT" \
  MAILPIT_SMTP_PORT="$MAILPIT_SMTP_PORT" \
  MAILPIT_UI_PORT="$MAILPIT_UI_PORT" \
  docker compose --project-name "$PROJECT" --file compose.yaml \
    up --detach --wait --quiet-pull postgres mailpit

if docker buildx version >/dev/null 2>&1; then
  DOCKER_BUILDKIT=1 docker build --progress=plain --tag "$IMAGE_TAG" .
else
  DOCKER_BUILDKIT=0 docker build --tag "$IMAGE_TAG" .
fi

docker run --rm --network "$NETWORK" \
  --env DATABASE_URL="$DATABASE_URL_CONTAINER" \
  "$IMAGE_TAG" ./node_modules/.bin/interview-agent-db-migrate

DATABASE_URL="postgresql://interview:interview@127.0.0.1:${POSTGRES_PORT}/interview" \
  pnpm question-bank:import

docker run --detach --name "$APP_CONTAINER" --network "$NETWORK" \
  --publish "127.0.0.1:${APP_PORT}:3000" \
  --env NODE_ENV=production \
  --env HOST=0.0.0.0 \
  --env PORT=3000 \
  --env DATABASE_URL="$DATABASE_URL_CONTAINER" \
  --env BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  --env BETTER_AUTH_URL="http://127.0.0.1:${APP_PORT}" \
  --env SMTP_HOST=mailpit \
  --env SMTP_PORT=1025 \
  --env SMTP_FROM=interview-agent@example.test \
  --env MODEL_PROVIDER=openai \
  --env MODEL_ID=gpt-4o-mini \
  --env MODEL_API_KEY="$MODEL_API_KEY" \
  --env LOG_LEVEL=info \
  "$IMAGE_TAG" >/dev/null

BASE_URL="http://127.0.0.1:${APP_PORT}"
for attempt in $(seq 1 60); do
  if curl --silent --show-error --fail \
    --dump-header "$ROOT_HEADERS" --output "$ROOT_BODY" \
    --header "accept: text/html" "$BASE_URL/" 2>/dev/null; then
    break
  fi
  if [[ "$attempt" -eq 60 ]]; then
    docker logs "$APP_CONTAINER"
    echo "Production container did not become ready." >&2
    exit 1
  fi
  sleep 1
done

grep --quiet '<div id="root">' "$ROOT_BODY"
grep --ignore-case --quiet '^content-security-policy:' "$ROOT_HEADERS"
grep --ignore-case --quiet '^strict-transport-security:' "$ROOT_HEADERS"
if grep --ignore-case --quiet '^access-control-allow-origin:' "$ROOT_HEADERS"; then
  echo "Production response unexpectedly enabled CORS." >&2
  exit 1
fi

DOCUMENTATION_STATUS="$(
  curl --silent --output /dev/null --write-out '%{http_code}' "$BASE_URL/documentation/json"
)"
[[ "$DOCUMENTATION_STATUS" == "404" ]]

ACCOUNT_STATUS="$(
  curl --silent --show-error --output "$RESPONSE_BODY" --write-out '%{http_code}' \
    "$BASE_URL/api/v1/account"
)"
[[ "$ACCOUNT_STATUS" == "401" ]]
node - "$RESPONSE_BODY" <<'NODE'
const body = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
if (body?.error?.code !== "unauthorized") {
  throw new Error("Unauthenticated account response was not the stable envelope");
}
NODE

OTP_STATUS="$(
  curl --silent --show-error --output "$RESPONSE_BODY" --write-out '%{http_code}' \
    --request POST "$BASE_URL/api/auth/email-otp/send-verification-otp" \
    --header "content-type: application/json" \
    --header "origin: $BASE_URL" \
    --data "{\"email\":\"$SMOKE_EMAIL\",\"type\":\"sign-in\"}"
)"
[[ "$OTP_STATUS" == "200" ]]

OTP=""
for attempt in $(seq 1 50); do
  MESSAGE_ID="$(
    curl --silent --show-error "http://127.0.0.1:${MAILPIT_UI_PORT}/api/v1/messages" |
      node -e '
        let input = "";
        process.stdin.on("data", (chunk) => (input += chunk));
        process.stdin.on("end", () => {
          const body = JSON.parse(input);
          process.stdout.write(body.messages?.[0]?.ID ?? "");
        });
      '
  )"
  if [[ -n "$MESSAGE_ID" ]]; then
    OTP="$(
      curl --silent --show-error \
        "http://127.0.0.1:${MAILPIT_UI_PORT}/api/v1/message/${MESSAGE_ID}" |
        node -e '
          let input = "";
          process.stdin.on("data", (chunk) => (input += chunk));
          process.stdin.on("end", () => {
            const body = JSON.parse(input);
            const match = JSON.stringify(body).match(/验证码是\s*(\d{6})/u);
            process.stdout.write(match?.[1] ?? "");
          });
        '
    )"
  fi
  if [[ -n "$OTP" ]]; then
    break
  fi
  if [[ "$attempt" -eq 50 ]]; then
    echo "Mailpit did not receive a readable OTP." >&2
    exit 1
  fi
  sleep 0.2
done

SIGN_IN_STATUS="$(
  curl --silent --show-error --dump-header "$RESPONSE_HEADERS" \
    --output "$RESPONSE_BODY" --write-out '%{http_code}' \
    --request POST "$BASE_URL/api/auth/sign-in/email-otp" \
    --header "content-type: application/json" \
    --header "origin: $BASE_URL" \
    --data "{\"email\":\"$SMOKE_EMAIL\",\"otp\":\"$OTP\",\"name\":\"Production Smoke\"}"
)"
[[ "$SIGN_IN_STATUS" == "200" ]]

SESSION_COOKIE="$(
  node - "$RESPONSE_HEADERS" <<'NODE'
const headers = require("node:fs").readFileSync(process.argv[2], "utf8");
const sessionHeader = headers
  .split(/\r?\n/u)
  .find(
    (line) =>
      line.toLowerCase().startsWith("set-cookie:") &&
      line.toLowerCase().includes("session_token"),
  );
const cookie = sessionHeader?.replace(/^set-cookie:\s*/iu, "").split(";")[0];
if (cookie === undefined || cookie.length === 0) {
  process.exit(1);
}
process.stdout.write(cookie);
NODE
)"

AUTHENTICATED_STATUS="$(
  curl --silent --show-error --output "$RESPONSE_BODY" --write-out '%{http_code}' \
    --header "cookie: $SESSION_COOKIE" "$BASE_URL/api/v1/account"
)"
[[ "$AUTHENTICATED_STATUS" == "200" ]]
node - "$RESPONSE_BODY" "$SMOKE_EMAIL" <<'NODE'
const body = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
if (body?.email !== process.argv[3]) {
  throw new Error("Authenticated account response did not match the smoke account");
}
NODE

CREATE_STATUS="$(
  curl --silent --show-error --output "$RESPONSE_BODY" --write-out '%{http_code}' \
    --request POST "$BASE_URL/api/v1/interviews" \
    --header "content-type: application/json" \
    --header "origin: $BASE_URL" \
    --header "cookie: $SESSION_COOKIE" \
    --header "idempotency-key: production-smoke-create" \
    --data '{"expectedVersion":0,"questionCount":5}'
)"
[[ "$CREATE_STATUS" == "200" ]]
node - "$RESPONSE_BODY" <<'NODE'
const body = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
if (body?.status !== "succeeded" || body?.result?.interviewVersion !== 1) {
  throw new Error("Production create-interview response was not canonical success");
}
NODE

ACTIVE_STATUS="$(
  curl --silent --show-error --output "$RESPONSE_BODY" --write-out '%{http_code}' \
    --header "cookie: $SESSION_COOKIE" "$BASE_URL/api/v1/interviews/active"
)"
[[ "$ACTIVE_STATUS" == "200" ]]
node - "$RESPONSE_BODY" <<'NODE'
const body = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
if (
  body?.status !== "active" ||
  body?.progress?.current !== 1 ||
  body?.progress?.total !== 5
) {
  throw new Error("Production active interview response was invalid");
}
NODE

echo "Production container smoke passed."

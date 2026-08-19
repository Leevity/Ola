# Ola Remote deployment smoke

The production compose stack fails closed unless all secrets and the public TURN address are
provided. Use a routable IP for `OLA_REMOTE_TURN_EXTERNAL_IP`; a container or RFC1918 address will
not work for internet peers.

```bash
export OLA_REMOTE_JWT_SECRET="$(openssl rand -hex 32)"
export OLA_REMOTE_TURN_SECRET="$(openssl rand -hex 32)"
export OLA_REMOTE_TURN_EXTERNAL_IP="203.0.113.10"
export OLA_REMOTE_TURN_URL="turn:${OLA_REMOTE_TURN_EXTERNAL_IP}:3478?transport=udp"
docker compose -f server/deploy/docker-compose.yml up --build -d --wait
```

The TURN relay range `49160-49200/udp`, TURN listener `3478/tcp+udp`, API `7300/tcp`, and signaling
`7301/tcp` must be allowed by the host firewall. Put API and signaling behind an HTTPS/WSS reverse
proxy before exposing them outside a development network.

Run the authenticated API/signaling/audit smoke against the stack:

```bash
OLA_REMOTE_SMOKE_API=http://127.0.0.1:7300 \
OLA_REMOTE_SMOKE_SIGNAL=ws://127.0.0.1:7301/ws/signaling \
node server/scripts/smoke.mjs
```

The smoke proves device-token issuance, one-time pairing authorization, authorization stripping,
authorized offer forwarding, immediate two-peer revoke, stats persistence, and account-scoped audit
queries. A separate two-device WebRTC run is still required to prove P2P and TURN media transport.

## Control plane and model gateway

The API process exposes the authenticated control plane under `/api/control/*` and
an OpenAI-compatible model gateway under `/v1/*`.

For local development, set `OLA_REMOTE_DEV_MODE=1` and optionally:

```text
OLA_CONTROL_PLANE_STATE_PATH=.ola-control-plane.json
OLA_SYSTEM_ADMIN_EMAILS=admin@example.com
OLA_MODEL_BASE_URL=https://api.openai.com/v1
OLA_MODEL_API_KEY=replace-me
OLA_MODEL_DEFAULT=gpt-4.1
```

The state path is an atomic local development store. With `OLA_REMOTE_DATABASE_URL` configured,
the API persists control-plane state through the `control_plane_state` PostgreSQL row; the
schema is also included in `migrations/002_control_plane.sql` for managed migrations.

The separate admin site is in `../../Ola-admin` and can be started with:

```bash
cd Ola-admin
npm install
npm run dev
```

Set `VITE_API_BASE_URL` to the API origin and `VITE_SIGNAL_URL` to the signaling WebSocket URL
when the API/signaling services are not running on localhost.

Development-only test accounts are seeded automatically when `OLA_REMOTE_DEV_MODE=1`:

```text
System admin:  admin@ola.test       / OlaAdmin123!
Team admin:    team-admin@ola.test  / OlaTeam123!
Basic user:    user@ola.test        / OlaUser123!
```

The seed can be disabled with `OLA_REMOTE_DEV_SEED=0`. These accounts are never created by the
production startup path.

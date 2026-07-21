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

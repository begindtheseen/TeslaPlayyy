# Deploying to Hetzner Cloud

One command creates a server that sets itself up on first boot: Docker, this repo, the app behind
Caddy (automatic HTTPS, required for WebCodecs), IPv6 source rotation, and a daily yt-dlp refresh.
Only the Hetzner API is used; no SSH is needed.

## What you need
1. A Hetzner Cloud project and an API token with **Read & Write** access
   (Hetzner Console → project → Security → API tokens).
2. Optional: a domain. Without one the site is `https://<ip-with-dashes>.sslip.io`, with a real
   Let's Encrypt certificate that the Tesla browser accepts.
3. Optional: an SSH key uploaded to the project (Security → SSH keys) if you want shell access;
   port 22 is only opened when you pass `--ssh-key`.

## Deploy
```bash
export HCLOUD_TOKEN=...                        # never commit it
npm run deploy:hetzner -- up                   # defaults: cpx31 (4 vCPU / 8 GB) in ash (Ashburn, US)
npm run deploy:hetzner -- up --location fsn1   # EU (Falkenstein)
npm run deploy:hetzner -- up --domain tv.example.com --ssh-key laptop --app-env .env.deploy
```
`up` prints the server IPs and the site URL, then waits (up to 20 min) for `/api/health`. The first
boot builds the Docker image, which takes about 5–10 minutes. With `--domain`, create an `A` record to
the printed IPv4. Caddy keeps retrying the certificate until DNS resolves.

`--app-env FILE` appends `KEY=VALUE` lines to the server's `.env.production`, for example
`YOUTUBE_API_KEY=...` or `PROXY_URLS=...`; see `.env.example` and `docs/RESILIENCE.md`.

```bash
npm run deploy:hetzner -- status               # server state + live /api/health summary
npm run deploy:hetzner -- destroy --yes        # delete the server and its firewall
```
Running `up` again while the server exists changes nothing. To apply new settings, `destroy` and
`up` again. Code updates arrive on their own (below).

## What runs on the server
- `/opt/canvastube`: a clone of `main`; `.env.production` holds `DOMAIN` and `EGRESS_IPV6_PREFIX`.
- `docker compose -f deploy/docker-compose.yml`: `app` (Next.js on 127.0.0.1:3000) and `caddy`
  (80/443), both with host networking.
- `canvastube-anyip.service`: routes the server's IPv6 /64 to `lo`, so each extraction can use a
  random source address (`EGRESS_IPV6_PREFIX`). At every boot it first tests a random address against
  youtube.com and only enables rotation if that works. Otherwise the app uses the server's default
  address; check the setup log, and `egress.mode` in `/api/health`.
- `canvastube-refresh.timer`: 04:15 UTC daily. It restarts the app, which pip-upgrades yt-dlp; on
  Sundays it also `git pull`s and rebuilds.
- Hetzner firewall `canvastube-web`: inbound 80 and 443 only (plus 22 with `--ssh-key`).
- Setup log: `/var/log/canvastube-setup.log`.

## Sizing and cost
Remuxing uses little CPU; bandwidth dominates. 1080p is about 2 GB per viewer-hour, all flowing
through the server. Check the traffic included with your server type and location on Hetzner's
pricing page: EU locations include far more than US ones. `cpx31` is comfortable for dozens of
simultaneous viewers.

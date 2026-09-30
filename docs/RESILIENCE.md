# Keeping YouTube extraction alive

Server-side extraction fails for boring, predictable reasons. This document says what the code already
does about each one, what you configure, and how to add IP rotation (Hetzner IPv6 notes included).

Scope stays the same everywhere: **public videos only**. Private, age-gated, members-only, DRM and
region-locked videos return clean errors (404/403/451). Nothing here logs in, uses cookies or works
around those restrictions.

## What breaks, and what the code does

| Failure | Symptom | Built-in handling |
|---|---|---|
| Server IP flagged (bot check, 429, "try again later") | yt-dlp `Sign in to confirm you're not a bot`, `HTTP Error 429` | Classified as `blocked` (429). The next client group from `YTDLP_CLIENTS` is tried with a fresh egress; the blocked egress cools down for `EGRESS_COOLDOWN_SECONDS`; rotation hooks fire. |
| One player client broken or needing PO tokens | `no_formats`, 403s | Client fallback: `android_vr,web_safari` → `tv,ios` → `mweb` (configurable). |
| googlevideo URL expired (~6 h) or used from another IP | CDN 403/404/410 mid-playback | The relay re-extracts once and continues the same response from the same byte. |
| CDN drops the connection mid-transfer | truncated body | The relay resumes from the exact byte (3 times in a row); after that the worker/FFmpeg reconnect by range. |
| Oversized range requests refused | CDN 403 on big ranges | Upstream is always fetched in `CDN_CHUNK_BYTES` (10 MiB) pieces. |
| Thundering herd on one video | many yt-dlp runs | 5-minute cache (capped by URL expiry), in-flight dedupe, permanent errors remembered for 2 minutes. |
| yt-dlp goes stale (YouTube changes weekly) | rising `extraction_failed` | Docker installs yt-dlp from pip; `YTDLP_UPDATE_ON_START=1` upgrades on boot. Rebuild often. |

Watch `GET /api/health` → `extraction.successRate`, `extraction.lastHour`, `extraction.byCode`,
`extraction.byClient`, `egress.coolingDown` and `relay.urlRefreshes`. A rising `blocked` share means
the egress IP is burned; a rising `extraction_failed` share usually means yt-dlp needs an update.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `YTDLP_PATH` | `yt-dlp` | Binary to run. |
| `YTDLP_CLIENTS` | `android_vr,web_safari\|tv,ios\|mweb` | `\|`-separated fallback groups, each passed as `youtube:player_client=<group>`. |
| `YTDLP_EXTRA_ARGS` | – | JSON array of extra yt-dlp args (e.g. a PO-token provider plugin's `--extractor-args`). Cookie/login flags are rejected. |
| `YTDLP_TIMEOUT_MS` | `45000` | Per-attempt timeout. |
| `EXTRACT_CACHE_SECONDS` | `300` | Result cache TTL (never beyond the CDN URL's `expire`). |
| `PROXY_URL` / `PROXY_URLS` | – | One proxy or a comma-separated rotation pool: `http://`, `https://`, `socks5://`, `socks5h://`, with optional `user:pass@`. Used for yt-dlp **and** all CDN traffic. |
| `EGRESS_SOURCE_ADDRESSES` | – | Comma list of local IPs to bind (round-robin, skipping cooled-down ones). |
| `EGRESS_IPV6_PREFIX` | – | e.g. `2a01:4f8:c0c:1234::/64`: a random address in the prefix per extraction (needs AnyIP, below). |
| `EGRESS_COOLDOWN_SECONDS` | `600` | How long a blocked egress is avoided. |
| `EGRESS_HOOK_MODULE` | – | Path to an ES module with optional `pick(ctx)` and `onBlocked(ctx)` (below). |
| `EGRESS_ROTATE_COMMAND` | – | Shell command run on a block (at most once a minute). Gets `EGRESS_ID` and `EGRESS_BLOCK_REASON`. |
| `CDN_ALLOWED_HOSTS` | `*.googlevideo.com,*.youtube.com,*.ytimg.com,*.googleusercontent.com` | Hosts media may be fetched from. |
| `CDN_CHUNK_BYTES` | `10485760` | Upstream range size. |
| `STREAM_MAX_RELAYS` | `64` | Concurrent googlevideo relays. |
| `MEDIA_MAX_STREAMS` | `8` | Concurrent FFmpeg processes (muxed path). |

Precedence: `PROXY_URLS` > `EGRESS_SOURCE_ADDRESSES` > `EGRESS_IPV6_PREFIX` > the server's default
route. A hook's `pick()` overrides all of them when it returns an egress.

**IP pinning:** googlevideo URLs carry the IP that extracted them (`ip=`). Every extraction result
remembers its egress, and every CDN request for that result (browser relay and FFmpeg's loopback
inputs alike) goes out through the same proxy or source address. Rotating an egress therefore only
affects new extractions; running streams keep working until their URL is refreshed.

## Hook module

```js
// rotator.mjs  (EGRESS_HOOK_MODULE=./rotator.mjs)
// pick: return {proxy} or {localAddress} to use for the next extraction, or null for the default pool.
export async function pick({ videoId, config }) { return null; }
// onBlocked: called when YouTube blocks an egress (bot check / 429). Rotate, alert, count...
export async function onBlocked({ egress, reason }) { /* egress.id, egress.localAddress */ }
```

## IPv6 rotation on Hetzner (or any host with a routed /64)

Hetzner Cloud and dedicated servers get a routed IPv6 /64. Binding each extraction to a different
address in it spreads requests over many source IPs. There are two ways to do it.

### A. Built in: random address per extraction (AnyIP)

1. Find the prefix: `ip -6 addr show dev eth0` → e.g. `2a01:4f8:c0c:1234::1/64`.
2. Let processes bind any address in the prefix without adding each one:
   ```sh
   sysctl -w net.ipv6.ip_nonlocal_bind=1
   ip -6 route add local 2a01:4f8:c0c:1234::/64 dev lo
   ```
   Persist both (e.g. `/etc/sysctl.d/99-anyip.conf` and a systemd-networkd `[Route]` with `Type=local`).
3. Set `EGRESS_IPV6_PREFIX=2a01:4f8:c0c:1234::/64`. Each extraction gets a random address. yt-dlp
   receives `--source-address <addr>` and every CDN socket for that video binds the same address.
4. Make sure outbound IPv6 works: `curl -6 --interface 2a01:4f8:c0c:1234::abcd https://www.youtube.com -I`.
5. Docker: run with `--network host`, or an IPv6-enabled network that routes the prefix into the
   container. The default bridge has no IPv6.

### B. External rotator

Tools like the Invidious project's `smart-ipv6-rotator` periodically move the host's preferred IPv6
source address. Run it on a timer, or on demand with
`EGRESS_ROTATE_COMMAND="smart-ipv6-rotator run --ipv6range=2a01:4f8:c0c:1234::/64"`. It then fires
whenever YouTube blocks the current address. In-flight streams keep working because their CDN URLs are
pinned to the address that extracted them, as long as that address stays configured on the host.

### Caveats (read before relying on it)

- YouTube can rate-limit whole prefixes (/64, sometimes /48). A single /64 buys headroom, not immunity.
  More prefixes (e.g. an additional Hetzner subnet) or a residential proxy pool (`PROXY_URLS`) go further.
- Datacenter IPv4 addresses are usually flagged fast. Prefer IPv6 or residential egress for extraction.
- The same egress must also serve the media bytes, so proxy bandwidth is the video bitrate times viewers,
  not just API calls. Price residential proxies accordingly.
- Server-side extraction is against YouTube's Terms of Service. Operating this service, and deciding what
  content and traffic it serves, is the operator's responsibility.

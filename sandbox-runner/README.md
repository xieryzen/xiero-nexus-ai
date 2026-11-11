# Xiero Nexus AI — Sandbox Runner (reference)

Runs agent-/user-provided code **outside** the Nexus application host. Nexus
never executes code itself; it sends `{ files, command, timeoutMs }` to this
runner and shows the result.

## Security model

The **container** is the boundary. This server only adds argv-only execution
(no shell), a timeout, and output caps. Always run it hardened:

```bash
docker build -t xiero-nexus-sandbox .

docker run --rm -p 127.0.0.1:8080:8080 \
  --network none \
  --memory 512m --cpus 1 --pids-limit 128 \
  --read-only --tmpfs /work:exec,size=256m \
  --cap-drop ALL --security-opt no-new-privileges \
  --user 10001:10001 \
  -e RUNNER_TOKEN="$(openssl rand -hex 24)" \
  -e WORK_BASE=/work \
  xiero-nexus-sandbox
```

- `--network none` — no network egress from executed code.
- `--memory / --cpus / --pids-limit` — resource caps.
- `--read-only` + `--tmpfs /work` — ephemeral, writable only under `/work`.
- `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user.
- Each request runs in a fresh temp dir under `WORK_BASE` and is deleted after.

> `--network none` blocks package installs. Pre-bake dependencies into the
> image, or run a separate, more-restricted image for installs. Do not add
> network back without a strong reason.

## Configure Nexus to use it

In the Nexus `.env`:

```
SANDBOX_URL=http://127.0.0.1:8080
SANDBOX_TOKEN=<same RUNNER_TOKEN>
# Allow Nexus to reach the (private) runner host:
ALLOW_PRIVATE_PROVIDER_HOSTS=127.0.0.1
# Optional: override the command allowlist
# SANDBOX_ALLOWED_COMMANDS=node,npm,npx,python3,pytest,tsc
```

If `SANDBOX_URL` is unset, execution stays disabled and Nexus returns a clear
message instead of running anything on its host.

## API

- `GET /health` → `{ ok: true }`
- `POST /run` (Bearer `RUNNER_TOKEN`) → body `{ files:[{path,content}], command, timeoutMs }`
  → `{ exitCode, stdout, stderr, durationMs }`

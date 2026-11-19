# Xiero Nexus AI: the browser service

The browser agents work in. It runs **apart from the app**: a browser that
opens what an agent asks for does not belong in the process that holds the
keys of your providers, your servers and your site accounts. The app speaks
to it over the DevTools protocol (`BROWSER_URL`).

`gate.mjs` is the service: it starts a Chromium without a window, lets the
app in and nobody else, and decides where pages may go.

- **Only the app gets in.** Whoever speaks the DevTools protocol with a
  browser can do anything in it, and Chromium asks for no password. The gate
  stands in front: every request needs the token.
- **Pages cannot reach private networks.** Everything the browser loads
  passes through a proxy in the gate, which refuses this machine, the network
  it is in, and the metadata address of a cloud. A page that redirects there,
  or asks for something there, gets a refusal instead. The gate connects to
  the address it looked at, so a name cannot lead somewhere else in between.
- **The browser says what it is.** Its user agent is Chromium's own, with
  "Headless" in it. Nothing is changed to look like a person's browser, and
  nothing solves or gets around a CAPTCHA: where a site asks for a person, the
  app hands the page to one.

## On a Pterodactyl node

`scripts/host/browser-service.sh` does all of this on the machine that runs
Wings: it builds the image, starts the container on the network of the
server, checks that the server reaches it, and writes `BROWSER_URL` into the
server's `.env`. From GitHub: the Deploy workflow, action `browser-plan`
(shows what it would do) and `browser`. See `scripts/host/README.md`.

## By hand

```bash
docker build -t xiero-browser scripts/host/browser

docker run -d --name xiero-browser --restart unless-stopped \
  -p 127.0.0.1:9223:9223 \
  --memory 1g --memory-swap 1g --cpus 1.5 --pids-limit 512 --shm-size 256m \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=384m,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges \
  -e BROWSER_TOKEN="$(openssl rand -hex 24)" \
  xiero-browser
```

- `--memory`, `--cpus`, `--pids-limit`: what a browser may take of the
  machine. One gigabyte carries a handful of pages.
- `--read-only` with a temporary folder in memory: nothing a page leaves
  behind outlasts the container.
- `--cap-drop ALL`, `no-new-privileges`, not root: the container is what
  stands between a page and the machine. Chromium's own sandbox needs rights
  a container does not have, so it is off inside (`CHROME_NO_SANDBOX=1`).
- `-p 127.0.0.1:9223:9223` publishes it to this machine only. For an app in
  another container, put both on one Docker network instead of publishing
  the port, and use the container's name or address.
- A build installs Debian's packages from inside a container on Docker's
  default network. Where the build ends at `apt-get update` (a name that is
  not found, nothing that connects), that network does not get to the
  outside on this machine:
  `docker build --network host -t xiero-browser scripts/host/browser` builds
  on the machine's own. (`browser-service.sh` asks first, and chooses.)

In the app's `.env`:

```
BROWSER_URL=http://127.0.0.1:9223/?token=<the same token>
```

The Browser page of the app then shows the service, and that it keeps pages
from private networks.

Rebuild the image now and then (`docker build --pull --no-cache …`, then
start the container again): that is how this Chromium gets its security
updates.

## Settings

| Variable | |
| --- | --- |
| `BROWSER_TOKEN` | Needed, at least 16 characters. The app has the same in `BROWSER_URL`. |
| `PORT` | Where the app connects (9223). |
| `HOST` | The address to listen on (0.0.0.0). |
| `CHROME_BIN` | The Chromium to start. In the image: `/usr/bin/chromium`. |
| `CHROME_HEADLESS` | `new` (default) for a full Chromium; `shell` for a build that is only the headless shell. |
| `CHROME_NO_SANDBOX` | `1`: start Chromium with `--no-sandbox`, as inside a container. |
| `CHROME_ARGS` | More arguments for Chromium, separated by spaces. |
| `ALLOW_PRIVATE_HOSTS` | Hosts on a private network that pages may reach all the same, separated by commas: a site of your own on your own network. |

## What it answers

- `GET /healthz`: 200 when Chromium is running. No token needed.
- `GET /json/version?token=…`: what the browser is, where to connect, and
  that this gate filters where pages go.
- `GET /devtools/browser/<id>?token=…`: the DevTools protocol, as a
  WebSocket, passed on to Chromium.

Anything else is 404; a missing or wrong token is 401.

## Another browser

`BROWSER_URL` can also name a DevTools address of another Chromium
(`ws://…`, or `http://…` that answers `/json/version`). The app then works
the same, but nothing tells it whether that browser can reach your private
network: the Browser page says so. The app itself never opens an address on
a private network, a file, or a page of the browser; what a page loads or
where it redirects is the browser's to refuse.

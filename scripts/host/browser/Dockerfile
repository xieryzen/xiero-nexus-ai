# The browser service of Xiero Nexus AI: a Chromium behind a gate (gate.mjs).
# The CONTAINER is the boundary: run it with the flags of the README, or let
# scripts/host/browser-service.sh do it on a Pterodactyl node.
FROM debian:bookworm-slim

# Chromium and Node.js as Debian ships them, and fonts for what a person is
# shown of a page. Nothing else. A list of packages that could not be fetched
# ends the build there, with the reason, and not later with "Unable to locate
# package".
RUN apt-get -o APT::Update::Error-Mode=any update \
 && apt-get install -y --no-install-recommends chromium nodejs ca-certificates fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

# What this browser never does, whoever asks: open a file of its own machine,
# keep passwords, sign in to an account of the browser's maker, send reports.
COPY policy.json /etc/chromium/policies/managed/xiero.json

# Not root, and with a home that is the temporary folder: with a read-only
# root file system, that is the only place it writes to.
RUN useradd --system --uid 10001 --user-group --home-dir /tmp --shell /usr/sbin/nologin browser
COPY gate.mjs /srv/gate.mjs

USER 10001:10001
ENV HOME=/tmp \
    PORT=9223 \
    CHROME_BIN=/usr/bin/chromium \
    CHROME_NO_SANDBOX=1
EXPOSE 9223
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||9223)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "/srv/gate.mjs"]

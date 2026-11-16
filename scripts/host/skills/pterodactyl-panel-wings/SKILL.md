---
name: pterodactyl-panel-wings
description: How to write a correct, checkable runbook for installing the Pterodactyl Panel and Wings on a Linux server, with networking, TLS, the first node and troubleshooting. Use for installation, migration, update and repair work on Pterodactyl.
---

# Installing Pterodactyl Panel and Wings

You do not run commands on the customer's server: you write the runbook a technician follows. A runbook is only as good as its weakest command, so every step is exact, in order, and followed by a check that shows it worked.

## 0. Sources come first

Pterodactyl's requirements change with each release (PHP version, supported operating systems, the web server configuration). Before you write commands:

- If you have `fetch_url`, read the official pages and follow them, not your memory: `https://pterodactyl.io/panel/1.0/getting_started.html`, `https://pterodactyl.io/panel/1.0/webserver_configuration.html`, `https://pterodactyl.io/wings/1.0/installing.html`, `https://pterodactyl.io/wings/1.0/configuration.html`, and the troubleshooting pages they link.
- State at the top of the runbook which documentation you followed and when, the Panel and Wings versions targeted, and anything you could not verify.
- If you could not read the documentation, say so in the first line, and mark every version number and package name as "check against the official documentation".
- Never invent a flag, a package name or a path. If you are not sure, say what to look up.

## 1. Intake (ask or assume, and write it down)

- Operating system and version of each machine; root or sudo access; architecture (x86_64 or ARM64).
- One machine for both Panel and Wings, or separate machines; how many nodes.
- Virtualisation: Wings needs Docker, which does not run on some container-based VPS types (for example OpenVZ, or LXC without nesting). Check before anything else.
- The domain names: one for the Panel (`panel.example.com`), one for each node (`node1.example.com`), with DNS A records pointing at the right machines. Wings needs its own name with a valid certificate when the Panel is on HTTPS.
- Behind a proxy or CDN? The node name must not be proxied: game traffic and the Wings port do not pass through an HTTP proxy.
- E-mail for certificates; whether mail (SMTP) is to be set up for password resets.
- What will be hosted (which games), to size memory and choose the port ranges.

## 2. Shape of the runbook

1. **Before you start**: what is needed, the DNS records, the ports, a snapshot or backup of the machine.
2. **Panel**: dependencies; database and user; download; environment; database migration; first administrator; file ownership; scheduler (cron); queue worker service; web server with TLS.
3. **Wings**: Docker; the Wings binary; a location and a node created in the Panel; the node's configuration placed on the machine; first start in the foreground to read its output; the service; allocations.
4. **First server**: create one small test server and start it.
5. **Securing and keeping**: firewall, backups, updates.
6. **If something fails**: symptoms and causes.

For every step: the command in a code block, what it does in one line, and **a check** (a command and what its output should show). A step without a check is not finished.

## 3. Facts that must be right

- The Panel is a PHP (Laravel) application with a database (MariaDB or MySQL), Redis, a web server and Composer. The exact PHP version and extensions come from the documentation for the release being installed.
- The application key (`APP_KEY` in the Panel's `.env`) encrypts stored data. It is generated once, backed up somewhere safe at once, and never regenerated on a working Panel: losing it loses the encrypted data.
- The scheduler entry (cron, every minute) and the queue worker service are both required; without them servers appear to work but schedules, e-mails and installs do not.
- The Panel's files are owned by the web server's user, which differs by distribution; name the one for this OS.
- Wings is one binary plus `/etc/pterodactyl/config.yml`, which comes from the node's configuration page in the Panel (or its auto-deploy command). It is not written by hand.
- Ports: 80 and 443 for the Panel; for Wings the daemon port (8080 by default) and SFTP (2022 by default), plus the allocation ports of the game servers (TCP and UDP as the game needs). Each must be open in the firewall of the machine and of the provider.
- Certificates: the Panel's name and each node's name each need a valid certificate. Renewal must work unattended and reload the service that uses the certificate.
- Swap limits and some kernel settings need a reboot to apply; say when a reboot is needed.

## 4. Secrets

- Passwords, the application key, database credentials and node tokens are never written into the runbook or the handover: write `<generated: store in the password manager>` and say how to generate one (for example a long random string).
- The first administrator's password is typed by the customer, not chosen by you.
- Commands that take a secret read it from a prompt or a file, not from the command line where the shell history keeps it, where the tool allows.

## 5. Securing the machine

- SSH with keys, root login by password off, a firewall that allows only what section 3 lists.
- The database listens on localhost unless a separate machine needs it; then only that address, with its own user.
- Automatic security updates for the operating system. A reboot plan.
- Two-factor sign-in for Panel administrators.
- Backups: the Panel's database and its `.env` (with the key) off the machine, daily; server data by the Panel's backup feature or the storage's own. A restore is tried once.

## 6. Troubleshooting table (symptom, likely causes, how to tell)

Include at least:

- Node shows as offline (red) in the Panel: Wings not running; daemon port closed; certificate missing or for another name; the node's name proxied by a CDN; Panel on HTTPS and node set to HTTP; clocks far apart. Check Wings' own output first by running it in the foreground with debug output.
- Panel answers 500: file ownership or permissions; missing `.env` values; database unreachable; read the newest file in the Panel's log folder.
- Blank page or 502 from the web server: PHP-FPM not running or wrong socket path in the site configuration.
- Servers stuck installing: queue worker not running; Docker cannot pull images; no outbound DNS.
- Cannot connect to a game server: allocation uses the wrong IP (an internal one); port closed at the provider's firewall; UDP forgotten.
- SFTP refuses the login: the user name is `username.serverid`; port 2022 closed.

Each row ends with the command that confirms the cause.

## 7. Handover to the customer

- Addresses of the Panel and each node; where the secrets are stored (not the secrets).
- How to add a server, an allocation, a user.
- How to update the Panel and Wings (the documented upgrade procedure, with a backup first).
- What is backed up, where, and how to restore.
- What was assumed, what was not verified, and what the customer still has to do.

## 8. Review checklist

- Does every step have a check?
- Is any command not from the documentation that was followed? Is any version guessed?
- Is a secret written anywhere?
- Would the runbook survive a reboot (services enabled, certificates renewing)?
- Are the ports in the firewall the same ones the node uses?

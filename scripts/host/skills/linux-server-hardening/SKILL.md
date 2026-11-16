---
name: linux-server-hardening
description: A baseline for securing a Linux server that is reachable from the internet: access, firewall, updates, secrets, backups and logs. Use when planning, documenting or reviewing a server that hosts a panel, a game server or a website.
---

# A Linux server that is safe to leave on the internet

Aim for a short list that is really done, each item with a command that proves it, rather than a long list nobody follows.

## Rules for what you write

- You write steps for a person to run; you do not run them. Each step: the command, what it changes, and a check.
- Commands differ by distribution and version. Name the one you wrote for; if you have `fetch_url`, confirm a command you are unsure of in the distribution's documentation. Do not guess package names.
- **Never lock the operator out**: before a firewall is enabled or SSH is changed, the step says to keep the current session open and test a second one.
- No secret in any document: `<generated>` and where it is kept.

## 1. Access

- A named user with sudo; work as that user, not as root.
- SSH by key. After a key login is proven to work: password authentication off, root login by password off. Changing the port is optional and not a control in itself.
- Brute-force protection (for example fail2ban or the firewall's rate limit) on SSH.
- Remove users and keys that are not needed. List who has access in the handover.

## 2. Firewall

- Default deny for incoming traffic; allow exactly the ports the services need, each with its protocol (TCP or UDP) and why.
- The provider's own firewall or security group counts too: a port must be open in both.
- Databases, caches (Redis), admin ports and metrics listen on localhost or a private network, never on a public address.
- Docker publishes ports past some host firewalls: say how published container ports are restricted on this setup.
- Check from outside the machine, not from itself: list the ports that answer.

## 3. Updates

- Automatic security updates for the operating system, with a stated time for reboots when a kernel update needs one.
- Applications (the panel, the game server software) are updated by their own documented procedure, after a backup.
- Remove packages and services that are not used.

## 4. Services

- Each service runs as its own unprivileged user where its documentation allows.
- Services are enabled so that they return after a reboot; a reboot is rehearsed before handover.
- TLS certificates renew unattended, and the renewal reloads the service that uses the certificate.
- Time is synchronised (tokens and certificates fail on a wrong clock).

## 5. Secrets

- Generated, long, unique for each service; kept in a password manager, not in chat or in a document.
- Files that hold secrets (`.env`, configuration with tokens) are readable by the service's user only.
- A way to rotate each secret is written down.

## 6. Backups

- What is backed up (data, databases, configuration, keys), how often, how many are kept.
- At least one copy off the machine, encrypted when it leaves it.
- A restore to another place is tried once before handover, and the time it took is noted.

## 7. Seeing trouble

- Where the logs are for each service, and the one command to read the latest errors.
- Disk space: an alert or at least a weekly look; log rotation is on.
- Who is told when the service is down, and how they find out.

## 8. Review checklist

- Which ports answer from the outside, and is each one needed?
- Can anyone log in with a password? As root?
- Would the machine come back by itself after a reboot tonight?
- If the disk died now, what is lost, and how long until service is back?
- Is any secret in a document, a script or the shell history?

State plainly what this baseline does not cover (for example DDoS protection, intrusion detection, compliance requirements), so that nobody assumes it does.

#!/bin/sh
# The first program in the runner's container.
#
# With RUNNER_FIREWALL=1 it closes the container's network to private
# addresses before anything else runs: what a program or a build fetches
# comes from the internet, and nothing here reaches this machine, the
# containers next to it, or a network behind them. The rules are set with the
# right to administer the network, which the container is started with for
# this and which the server and every program then run without.
#
#   RUNNER_ALLOW   addresses or networks that are let through all the same,
#                  separated by spaces: a package mirror of your own
#   RUNNER_DENY    more addresses that are refused: the public addresses of
#                  this machine
set -eu

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

if [ "${RUNNER_FIREWALL:-}" = "1" ]; then
  [ "$(id -u)" = "0" ] || fail "RUNNER_FIREWALL=1 needs the container to start as root (the server then starts every program as another user: RUNNER_RUN_AS)."

  # ── IPv4 ──
  IPT=""
  for candidate in iptables iptables-nft iptables-legacy; do
    if command -v "${candidate}" > /dev/null 2>&1 && "${candidate}" -w 5 -S OUTPUT > /dev/null 2>&1; then
      IPT="${candidate}"
      break
    fi
  done
  [ -n "${IPT}" ] || fail "the rules of the network cannot be set here: iptables does not work in this container. It needs the capability NET_ADMIN (docker run --cap-add NET_ADMIN) and a kernel with netfilter."
  rule() { "${IPT}" -w 5 "$@" || fail "a rule of the network could not be set: $*"; }
  rule -F OUTPUT
  rule -A OUTPUT -o lo -j ACCEPT
  # What answers a connection that came in: the app asks, and gets its answer.
  rule -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  # Names are looked up wherever Docker looks them up.
  rule -A OUTPUT -p udp --dport 53 -j ACCEPT
  rule -A OUTPUT -p tcp --dport 53 -j ACCEPT
  for net in ${RUNNER_ALLOW:-}; do rule -A OUTPUT -d "${net}" -j ACCEPT; done
  # Refused at once where the kernel can say so, else dropped.
  if "${IPT}" -w 5 -A OUTPUT -d 0.0.0.0/8 -j REJECT --reject-with icmp-admin-prohibited 2> /dev/null; then
    refuse() { rule -A OUTPUT -d "$1" -j REJECT --reject-with icmp-admin-prohibited; }
  else
    rule -A OUTPUT -d 0.0.0.0/8 -j DROP
    refuse() { rule -A OUTPUT -d "$1" -j DROP; }
  fi
  # Private, link-local, shared and reserved addresses, and multicast.
  for net in 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3 ${RUNNER_DENY:-}; do
    refuse "${net}"
  done
  "${IPT}" -w 5 -S OUTPUT | grep -q -- '-d 10.0.0.0/8' || fail "the rules of the network were set, but are not there when asked for."

  # ── IPv6: nothing but answers ──
  IP6=""
  for candidate in ip6tables ip6tables-nft ip6tables-legacy; do
    if command -v "${candidate}" > /dev/null 2>&1 && "${candidate}" -w 5 -S OUTPUT > /dev/null 2>&1; then
      IP6="${candidate}"
      break
    fi
  done
  if [ -n "${IP6}" ]; then
    "${IP6}" -w 5 -F OUTPUT
    "${IP6}" -w 5 -A OUTPUT -o lo -j ACCEPT
    "${IP6}" -w 5 -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    "${IP6}" -w 5 -A OUTPUT -j REJECT 2> /dev/null || "${IP6}" -w 5 -A OUTPUT -j DROP || fail "the rules of the network for IPv6 could not be set."
  elif [ -r /proc/net/if_inet6 ] && grep -qv ' lo$' /proc/net/if_inet6; then
    fail "this container has an IPv6 address, and the rules for IPv6 cannot be set here (ip6tables does not work). Start it on a network without IPv6."
  fi
  echo "The network is closed to private addresses (${IPT})."

  # The server and what it starts go on without the right that set the rules.
  if command -v setpriv > /dev/null 2>&1 && setpriv --bounding-set -net_admin,-net_raw,-setpcap --inh-caps -all true 2> /dev/null; then
    exec setpriv --bounding-set -net_admin,-net_raw,-setpcap --inh-caps -all node /srv/server.mjs
  fi
  echo "warning: the right to administer the network could not be given up for the server itself. Programs run as another user and never have it." >&2
fi

exec node /srv/server.mjs

#!/bin/sh
# Prints the Worker's anonymous daily counters as a table.
#
#   STATS_TOKEN=... ./scripts/stats.sh [days]
#   STATS_URL=http://127.0.0.1:8805 STATS_TOKEN=... ./scripts/stats.sh 7   # local wrangler dev
#
# The token is the secret set with `wrangler secret put STATS_TOKEN` (at least
# 32 characters, e.g. `openssl rand -hex 32`; a shorter one switches the
# endpoint off). "actief" counts networks (an IPv4 address or IPv6 /48) with an
# active install, at most one per network per day.
set -eu
DAYS="${1:-30}"
URL="${STATS_URL:-https://leeswijzer-api.minuut.eu}"
: "${STATS_TOKEN:?Set STATS_TOKEN to the secret from wrangler secret put STATS_TOKEN}"

if ! BODY=$(curl -sS -w '\n%{http_code}' -H "Authorization: Bearer $STATS_TOKEN" "$URL/v1/stats?days=$DAYS"); then exit 1; fi
CODE=$(printf '%s' "$BODY" | tail -n 1)
if [ "$CODE" != 200 ]; then
  echo "Server answered $CODE (401: wrong token; 404: STATS_TOKEN not set on the Worker)." >&2
  exit 1
fi
printf '%s' "$BODY" | sed '$d' | python3 -c '
import json, sys
days = json.load(sys.stdin)["days"]
def total(c, prefix):
    return sum(n for k, n in c.items() if k.startswith(prefix))
cols = [
    ("datum", lambda c: None),
    ("actief", lambda c: total(c, "ping:")),
    ("install", lambda c: total(c, "install:")),
    ("oordelen", lambda c: total(c, "judge:")),  # judge calls: Jev answers + cache hits
    ("core", lambda c: c.get("judge:core", 0)),
    ("segment", lambda c: c.get("judge:segment", 0)),
    ("ruling", lambda c: c.get("judge:ruling", 0)),
    ("zinnen", lambda c: c.get("judge:sentences", 0)),
    ("NL", lambda c: c.get("src:nl", 0)),
    ("EU-nl", lambda c: c.get("src:eu_nl", 0)),
    ("EU-en", lambda c: c.get("src:eu_en", 0)),
    ("cache hit", lambda c: c.get("cache:hit", 0)),
    ("miss", lambda c: c.get("cache:miss", 0)),
    ("lookups", lambda c: c.get("lookup:core", 0) + c.get("lookup:sentences", 0)),
    ("lookup hit", lambda c: c.get("lookup:hit", 0)),
    ("Jev", lambda c: c.get("jev:calls", 0)),
    ("cache fout", lambda c: c.get("cache:error", 0)),
    ("Jev fout", lambda c: c.get("upstream:error", 0)),
    ("Jev druk", lambda c: c.get("upstream:busy", 0)),
    ("429", lambda c: c.get("refused:rate_limit", 0)),
    ("druk", lambda c: c.get("refused:global", 0)),
    ("503", lambda c: c.get("refused:unavailable", 0)),
    ("1.0.x", lambda c: c.get("legacy:judge", 0)),  # calls to the old workers.dev host
]
rows = [[d["date"]] + [str(f(d["counters"])) for _, f in cols[1:]] for d in days]
widths = [max(len(h), *(len(r[i]) for r in rows)) for i, (h, _) in enumerate(cols)]
line = lambda cells: "  ".join(c.rjust(w) if i else c.ljust(w) for i, (c, w) in enumerate(zip(cells, widths)))
print(line([h for h, _ in cols]))
for r in rows:
    print(line(r))
versions = {}
for d in days:
    for k, n in d["counters"].items():
        if k.startswith("ping:"):
            versions[k[5:]] = versions.get(k[5:], 0) + n
if versions:
    print()
    print("actief per versie (som van dagen, netwerken):", ", ".join(f"{v} {n}" for v, n in sorted(versions.items())))
'

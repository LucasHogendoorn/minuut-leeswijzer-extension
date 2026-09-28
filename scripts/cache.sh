#!/bin/sh
# Looks into the Worker's shared cache (D1 database leeswijzer-cache).
#
#   ./scripts/cache.sh            size of the database and the templates in it (reads a few dozen rows)
#   ./scripts/cache.sh rows       rows per template (scans the whole answers table: one row read per row)
#   ./scripts/cache.sh prune TPL [N]
#                                 deletes up to N (default 20000) rows of retired template TPL
#
# Against the local database of `wrangler dev`: CACHE_WHERE=--local (and, if
# wrangler dev ran with --persist-to DIR, CACHE_WHERE="--local --persist-to DIR").
#
# Free-plan budget (https://developers.cloudflare.com/d1/platform/pricing/): 5 million rows read
# and 100,000 rows written per day. "rows" reads every row once; every deleted row counts as a row
# written, so prune a large template over several days.
set -eu
cd "$(dirname "$0")/../worker"
WHERE="${CACHE_WHERE:---remote}"
DB=leeswijzer-cache
sql() { wrangler d1 execute "$DB" $WHERE --command "$1"; }

case "${1:-}" in
"")
  if [ "$WHERE" = "--remote" ]; then wrangler d1 info "$DB"; fi
  sql "SELECT tpl, kind, lang, court, model, since FROM templates ORDER BY kind, lang, court, since"
  ;;
rows)
  sql "SELECT t.tpl, t.kind, t.lang, t.court, t.since, (SELECT count(*) FROM answers AS a WHERE a.tpl = t.tpl) AS rows FROM templates AS t ORDER BY t.kind, t.lang, t.court, t.since"
  ;;
prune)
  TPL="${2:?Give the template fingerprint (tpl) to prune}"
  N="${3:-20000}"
  case "$TPL$N" in *[!0-9]*) echo "TPL and N must be numbers." >&2; exit 1 ;; esac
  # A template is retired when a newer one with the same kind, lang and court
  # exists (its `since` is later): the Worker no longer asks for its rows.
  sql "DELETE FROM answers WHERE tpl = $TPL AND k IN (SELECT k FROM answers WHERE tpl = $TPL LIMIT $N)"
  sql "DELETE FROM templates WHERE tpl = $TPL AND NOT EXISTS (SELECT 1 FROM answers WHERE tpl = $TPL)"
  ;;
*)
  echo "Usage: $0 [rows | prune TPL [N]]" >&2
  exit 1
  ;;
esac

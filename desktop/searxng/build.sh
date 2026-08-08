#!/usr/bin/env bash
# Assemble a self-contained, RELOCATABLE SearXNG for the desktop installer.
#
# Run per OS (CI matrix), same as the tsnet sidecar:
#   bash desktop/searxng/build.sh desktop/searxng/bin
#
# Produces:
#   <out>/searx/          the application (from the source tarball)
#   <out>/lib/            every dependency, flat — plus our pwd shim (see pwd.py)
#   <out>/settings.yml    template; the shell rewrites secret_key + port at boot
#
# Started later as:  <python> -m searx.webapp   with PYTHONPATH=<out>/lib:<out>
#
# ⚠️ NOT YET WIRED: this produces everything EXCEPT a Python runtime. The user's machine has no
# Python, so a relocatable one (python-build-standalone) still has to be fetched and shipped
# alongside — that is the one unproven step. See README.md in this directory.
set -euo pipefail

OUT="${1:-bin}"
# ⚠️ A COMMIT, never `master`. SearXNG cuts no releases at all — master is what everyone runs — so
# tracking it would mean two VDS builds a day apart contain different SearXNG, with no way to say
# afterwards which. That breaks reproducible builds, bug reports and rollback in one go.
# Bump this deliberately at each 0.x release; see docs/DRITTANBIETER.md.
REF="${SEARXNG_REF:-b023a28bab8839dba9eac96e9a51cc91bbd0a267}"   # 2026-08-06

rm -rf "$OUT"
mkdir -p "$OUT"
cd "$OUT"

# ⚠️ TARBALL, NEVER `git clone`. Four files in the repo carry a colon in their name
# (utils/templates/etc/nginx/default.apps-available/searxng.conf:socket and three siblings). A
# colon is illegal in an NTFS path, so the checkout aborts on Windows — including on the
# windows-latest runner. The tarball lets us extract only the parts we run.
echo "== fetching SearXNG ($REF) =="
curl -sSL -o src.tar.gz "https://codeload.github.com/searxng/searxng/tar.gz/$REF"
tar -xzf src.tar.gz --wildcards '*/searx/*' '*/requirements.txt'
# The tarball's top directory is searxng-<ref>; with a commit ref that is the full sha.
top=$(ls -d searxng-*/ | head -1)
mv "$top/searx" .
mv "$top/requirements.txt" .
rm -rf "$top" src.tar.gz
test -f searx/webapp.py || { echo "::error::searx/webapp.py missing after extract"; exit 1; }

# `--target` (not a venv): a venv bakes absolute paths into pyvenv.cfg and its scripts, so it
# breaks the moment the app is installed somewhere else. A flat directory on PYTHONPATH does not.
echo "== installing dependencies =="
python -m pip install --quiet --target lib -r requirements.txt

# The one file that makes Windows work at all. Harmless elsewhere.
cp "$(dirname "$0")/pwd.py" lib/pwd.py

cp "$(dirname "$0")/settings.yml" settings.yml

echo "== done: $(du -sh . | cut -f1) =="

#!/usr/bin/env bash
# Assemble a self-contained, RELOCATABLE SearXNG for the desktop installer.
#
# Run per OS (CI matrix), same as the tsnet sidecar:
#   bash desktop/searxng/build.sh desktop/searxng/bin
#
# Produces:
#   <out>/python/         a relocatable CPython — the user's machine has none
#   <out>/searx/          the application (from the source tarball)
#   <out>/lib/            every dependency, flat — plus our pwd shim (see pwd.py)
#   <out>/settings.yml    template; the shell rewrites secret_key + port at boot
#
# Started later as:  <out>/python/... -m searx.webapp   with PYTHONPATH=<out>/lib:<out>
set -euo pipefail

# ⚠️ Resolve BEFORE the cd below. $0 is whatever the caller typed, so a relative invocation
# (bash desktop/searxng/build.sh …) leaves dirname pointing at a path that no longer exists once
# we are inside the output directory — which is exactly how this failed the first time it ran.
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

OUT="${1:-bin}"
# ⚠️ A COMMIT, never `master`. SearXNG cuts no releases at all — master is what everyone runs — so
# tracking it would mean two VDS builds a day apart contain different SearXNG, with no way to say
# afterwards which. That breaks reproducible builds, bug reports and rollback in one go.
# Bump this deliberately at each 0.x release; see docs/DRITTANBIETER.md.
REF="${SEARXNG_REF:-b023a28bab8839dba9eac96e9a51cc91bbd0a267}"   # 2026-08-06

# python-build-standalone: a CPython that runs from wherever it is unpacked. Pinned to an exact
# release AND patch version for the same reason as SEARXNG_REF — "latest" would put a different
# interpreter in two builds a day apart with nothing recording which.
PY_REL="${PY_REL:-20260807}"
PY_VER="${PY_VER:-3.12.13}"

rm -rf "$OUT"
mkdir -p "$OUT"
# ⚠️ Keep the marker the empty directory is committed with. electron-builder aborts when an
# extraResources source does not exist, so a developer who has never run this script must still
# find a directory there — and this script's own rm would otherwise take it away.
touch "$OUT/.gitkeep"
cd "$OUT"

# ── the runtime ────────────────────────────────────────────────────────────────────────────
case "$(uname -s)|$(uname -m)" in
  MINGW*|MSYS*|CYGWIN*)  PY_PLAT=x86_64-pc-windows-msvc ;;
  Darwin\|arm64)         PY_PLAT=aarch64-apple-darwin ;;
  Darwin\|x86_64)        PY_PLAT=x86_64-apple-darwin ;;
  *) echo "::error::no pinned Python for $(uname -s)/$(uname -m)"; exit 1 ;;
esac
echo "== fetching CPython $PY_VER ($PY_PLAT) =="
curl -sSL -o py.tar.gz \
  "https://github.com/astral-sh/python-build-standalone/releases/download/$PY_REL/cpython-$PY_VER+$PY_REL-$PY_PLAT-install_only.tar.gz"
tar -xzf py.tar.gz          # unpacks a top-level python/
rm -f py.tar.gz
# install_only layout differs per OS: python.exe at the root on Windows, bin/python3 elsewhere.
if   [ -f python/python.exe ];  then PYBIN="$PWD/python/python.exe"
elif [ -x python/bin/python3 ]; then PYBIN="$PWD/python/bin/python3"
else echo "::error::no interpreter in the extracted runtime"; ls -R python | head -20; exit 1; fi
"$PYBIN" -c "import sys; print('   runtime:', sys.version.split()[0])"

# ── the application ────────────────────────────────────────────────────────────────────────
# ⚠️ TARBALL, NEVER `git clone`. Four files in the repo carry a colon in their name
# (utils/templates/etc/nginx/default.apps-available/searxng.conf:socket and three siblings). A
# colon is illegal in an NTFS path, so the checkout aborts on Windows — including on the
# windows-latest runner. The tarball lets us extract only the parts we run.
echo "== fetching SearXNG ($REF) =="
curl -sSL -o src.tar.gz "https://codeload.github.com/searxng/searxng/tar.gz/$REF"
# ⚠️ --wildcards is GNU-only; macOS ships BSD tar and fails outright ("Option --wildcards is not
# supported"). BSD tar globs extraction patterns by default, GNU tar needs to be told. Extracting
# everything instead is NOT an option — the colon-bearing files above are the reason we are
# picking parts out of a tarball in the first place.
if tar --version 2>/dev/null | grep -qi 'gnu tar'; then
  tar -xzf src.tar.gz --wildcards '*/searx/*' '*/requirements.txt'
else
  tar -xzf src.tar.gz '*/searx/*' '*/requirements.txt'
fi
# The tarball's top directory is searxng-<ref>; with a commit ref that is the full sha.
top=$(ls -d searxng-*/ | head -1)
mv "$top/searx" .
mv "$top/requirements.txt" .
rm -rf "$top" src.tar.gz
test -f searx/webapp.py || { echo "::error::searx/webapp.py missing after extract"; exit 1; }

# `--target` (not a venv): a venv bakes absolute paths into pyvenv.cfg and its scripts, so it
# breaks the moment the app is installed somewhere else. A flat directory on PYTHONPATH does not.
#
# ⚠️ With the BUNDLED interpreter, never the build machine's. Wheels are built per Python version
# and ABI; installing with the runner's 3.14 and shipping a 3.12 yields an ImportError on the
# user's machine that never appears in CI.
echo "== installing dependencies =="
"$PYBIN" -m pip install --quiet --disable-pip-version-check --target lib -r requirements.txt

# ── prune ──────────────────────────────────────────────────────────────────────────────────
# A standalone CPython ships to be a full development install. A web application needs none of
# that, and the user pays for every megabyte twice — once on download, once on disk. Measured on
# Windows: 248 MB -> 150 MB, with the import check below still passing.
#   *.pdb      debug symbols, over 50 MB of them, never read at runtime
#   tkinter…   a GUI toolkit, plus the Tcl runtime behind it
#   test       CPython's own test suite
#   idlelib…   the bundled editor, 2to3, the turtle demos, ensurepip
echo "== pruning the runtime =="
find python -name '*.pdb' -delete
for junk in tkinter idlelib turtledemo lib2to3 ensurepip test; do
  find python -type d -name "$junk" -prune -exec rm -rf {} + 2>/dev/null || true
done
rm -rf python/tcl python/DLLs/tcl86t.dll python/DLLs/tk86t.dll python/DLLs/_tkinter.pyd 2>/dev/null || true

# The one file that makes Windows work at all. Harmless elsewhere.
cp "$SRC_DIR/pwd.py" lib/pwd.py

cp "$SRC_DIR/settings.yml" settings.yml

# ⚠️ Prove it IMPORTS before calling this a build. Every failure mode this bundle has — a wheel
# built for the wrong Python, the missing pwd shim on Windows, an extract that dropped files —
# surfaces here in one second instead of as a silent "no search results" on a user's machine weeks
# later. This is the step that turns a green CI run into evidence.
# ⚠️ Needs a REAL settings file, not the shipped template: SearXNG refuses to start on the
# placeholder secret (correctly — a constant key shipped worldwide would be no key at all), so
# importing against the template only ever proves that check works.
echo "== verifying =="
sed -e "s/__SECRET_KEY__/verify-only-never-shipped/" -e "s/__PORT__/18099/" settings.yml > .verify.yml
SEARXNG_SETTINGS_PATH="$PWD/.verify.yml" PYTHONPATH="$PWD/lib:$PWD"   "$PYBIN" -c "import searx.webapp; print('   searx.webapp imports OK')"
rm -f .verify.yml

echo "== done: $(du -sh . | cut -f1) =="

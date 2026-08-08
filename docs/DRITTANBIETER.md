# Mitgelieferte Fremdkomponenten

Die Desktop-App liefert fremde Software mit. Damit sind **wir** diejenigen, die eine Sicherheitslücke
darin an unsere Nutzer verteilen — der Docker-Selbsthoster zieht ein neues Image, der Desktop-Nutzer
drückt unseren Update-Knopf. Diese Seite sagt, was mitkommt, wie es festgenagelt ist und wann es
angefasst wird.

| Komponente | Wozu | Festgenagelt in | Erreichbar von |
|---|---|---|---|
| **Postgres** (`embedded-postgres` + `@embedded-postgres/*`) | die Datenbank, statt Docker | `desktop/package-lock.json` | nur localhost |
| **tsnet** (`tailscale.com`) | „Handy verbinden", Funnel | `desktop/tsnet-sidecar/go.mod` | ⚠️ **öffentliches Internet** — terminiert TLS |
| **SearXNG** + ~20 Python-Pakete | Websuche (Logos, Recherche) | `desktop/searxng/build.sh` → `REF=<commit>` | ausgehend, verarbeitet fremdes HTML |
| **Electron / Chromium** | die App-Hülle | `desktop/package-lock.json` | rendert lokale Seiten |

## Die Regel

**Bei jedem `0.x.0`-Release vorher aktualisieren** — kein automatischer Job, keine Bot-PRs. Bei
unserer Kadenz (0.18 → 0.26 an einem Tag) ist „vor dem Release" ohnehin oft genug, und ein
Mensch, der beim Hochziehen kurz nachdenkt, ist mehr wert als ein Bot, der Rauschen erzeugt.

```bash
# 1. Was gibt es Neues?
(cd desktop && npm outdated)                                  # Postgres, Electron
(cd desktop/tsnet-sidecar && go list -m -u tailscale.com)      # tsnet
gh api repos/searxng/searxng/commits/master -q '.sha'          # SearXNG

# 2. Hochziehen
(cd desktop && npm update embedded-postgres electron)
(cd desktop/tsnet-sidecar && go get -u tailscale.com && go mod tidy && go build ./...)
#    SearXNG: REF in desktop/searxng/build.sh auf den neuen Commit setzen (+ Datum im Kommentar)

# 3. Prüfen, bevor getaggt wird
(cd desktop && node scripts/headless-smoke.mjs)
```

## Was das NICHT abdeckt — und was stattdessen hilft

Eine Aktualisierung pro Release erfährt nichts von einer Lücke, die **zwischen** zwei Releases
bekannt wird. Dafür braucht es keinen eigenen Job: **GitHub meldet das kostenlos**, sobald es
eingeschaltet ist.

> ⚠️ **Aktuell ausgeschaltet.** Repository → Settings → *Advanced Security* → **Dependabot alerts**
> einschalten. Das deckt `package-lock.json` und `go.mod` ab, also **Postgres, Electron und tsnet**
> — mit CVE-Genauigkeit statt „es gibt was Neueres". Nur Alerts, keine automatischen PRs; das
> Hochziehen bleibt beim Release.

Nicht abgedeckt bleibt **SearXNG samt seiner Python-Pakete** (Tarball, kein Manifest, das GitHub
lesen kann). Das ist die bewusst in Kauf genommene Lücke — mit dem Hinweis, dass `lxml` und Co.
fremdes HTML verarbeiten und durchaus CVEs haben.

## Dringlichkeit ist nicht gleich verteilt

**tsnet zuerst.** Es ist das einzige Stück, das direkt am öffentlichen Internet hängt und TLS
terminiert. Eine Lücke dort ist etwas völlig anderes als eine in einem HTML-Parser, der nur
Suchergebnisse liest — und es ist zugleich das, was Dependabot über `go.mod` zuverlässig meldet.

Postgres lauscht nur auf localhost. SearXNG spricht nach außen, nimmt aber nichts entgegen.

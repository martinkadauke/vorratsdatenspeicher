// VDS remote-access sidecar: an EMBEDDED Tailscale node (tsnet) — no system Tailscale install,
// no admin, no OS prompt. Compiled once into a small binary that ships inside the VDS installer
// (like the Postgres sidecar). It exposes the local VDS backend to the internet via Tailscale
// Funnel: a stable HTTPS *.ts.net URL whose TLS terminates HERE, so Tailscale only ever relays
// ciphertext. The interactive login URL is printed for the Electron shell to open in-app — the
// user never leaves VDS.
//
// Parent contract (stdout, one key=value line per event):
//   VDS_AUTH_URL=<url>     login needed → open this in the VDS window
//   VDS_PUBLIC_URL=<url>   node is up → the https://…ts.net address (for the connect-phone QR)
//   VDS_FUNNEL=up          funnel serving; traffic proxies to the local backend
//   VDS_FUNNEL_ERR=<msg>   funnel refused (usually: HTTPS/Funnel not yet enabled for the tailnet)
//   VDS_CONSENT_URL=<url>  ONE click enables both tailnet prerequisites — show this, not a how-to
//   VDS_CONSENT_TEXT=<s>   Tailscale's own wording for what that click does
//   VDS_CERT=requesting|ok · VDS_CERT_ERR=<msg>   the node fetching its own certificate
//
// Env: VDS_LOCAL_PORT (backend port, required) · TSNET_DIR (state dir, persists login) ·
//      TS_HOSTNAME (node name).
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

func emit(key, val string) {
	// Newlines would split one event into two lines and desync the parent's line parser.
	fmt.Printf("%s=%s\n", key, strings.NewReplacer("\r", " ", "\n", " ").Replace(val))
	os.Stdout.Sync()
}

func main() {
	localPort := os.Getenv("VDS_LOCAL_PORT")
	if localPort == "" {
		log.Fatal("VDS_LOCAL_PORT is required")
	}
	dir := os.Getenv("TSNET_DIR")
	if dir == "" {
		dir = "./tsnet-state"
	}
	// The name the user sees in Tailscale (device list + the join prompt). Must read like the
	// product, not like an internal binary. Tailscale lowercases/hyphenates it for the hostname.
	host := os.Getenv("TS_HOSTNAME")
	if host == "" {
		host = "Vorratsdatenspeicher-Desktop"
	}

	// The shell kills us on quit, but a hard crash of the parent would otherwise leave this node
	// online and the household exposed with nobody watching. stdin closing = parent gone.
	go func() {
		io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}()

	var authSeen string
	s := &tsnet.Server{
		Dir:      dir,
		Hostname: host,
		// Belt and suspenders next to Status().AuthURL below: some tsnet versions surface the
		// interactive URL only in the log stream. Everything else stays quiet.
		Logf: func(format string, args ...any) {
			line := fmt.Sprintf(format, args...)
			if i := strings.Index(line, "https://login.tailscale.com/"); i >= 0 {
				if u := strings.Fields(line[i:])[0]; u != authSeen {
					authSeen = u
					emit("VDS_AUTH_URL", u)
				}
			}
		},
	}
	defer s.Close()

	if err := s.Start(); err != nil {
		log.Fatalf("tsnet start: %v", err)
	}

	lc, err := s.LocalClient()
	if err != nil {
		log.Fatalf("localclient: %v", err)
	}

	// Wait until authenticated + running, then publish the public hostname.
	ctx := context.Background()
	var publicHost string
	for {
		st, err := lc.Status(ctx)
		if err == nil && st != nil {
			if st.AuthURL != "" && st.AuthURL != authSeen {
				authSeen = st.AuthURL
				emit("VDS_AUTH_URL", st.AuthURL)
			}
			if st.BackendState == "Running" && st.Self != nil {
				publicHost = strings.TrimSuffix(st.Self.DNSName, ".")
				emit("VDS_PUBLIC_URL", "https://"+publicHost)
				break
			}
		}
		time.Sleep(time.Second)
	}

	// ── the one click that replaces two admin-console procedures ────────────────────────────
	// Funnel needs two TAILNET-WIDE things: HTTPS certificates enabled, and a `funnel` nodeAttr in
	// the policy file. Both are owner-only, and we cannot set them for the user: Tailscale has no
	// consumer-style OAuth consent, and creating an API client is itself an admin-console chore —
	// so "automating" it would be harder than the thing it automates.
	//
	// But Tailscale ships exactly the flow we want and the CLI already uses it: QueryFeature
	// returns a CONSENT URL that enables BOTH requirements at once, with one click, in the user's
	// own browser. That turns "open the DNS page, find HTTPS Certificates, enable; then open the
	// ACL page, switch to the JSON editor, paste a nodeAttrs block" — which is what we were asking
	// of people last night — into a single link we hand them.
	//
	// ShouldWait means the enablement is quick and we can just keep waiting; the funnel retry loop
	// below does that anyway, so the app recovers on its own the moment they click.
	if info, err := lc.QueryFeature(ctx, "funnel"); err != nil {
		emit("VDS_CONSENT_ERR", err.Error())
	} else if !info.Complete && info.URL != "" {
		emit("VDS_CONSENT_TEXT", info.Text)
		emit("VDS_CONSENT_URL", info.URL)
	}

	// ⚠️ Fetch the TLS certificate BEFORE serving. Tailscale does not publish a funnel node's public
	// DNS record until that node holds a certificate for its name, and the node is the one that has
	// to ask for it (the CLI equivalent is `tailscale cert`). Relying on lazy issuance at the first
	// TLS handshake cannot work: no certificate → no DNS record → no first handshake. The admin
	// console showed exactly that dead end — machine Connected, Funnel badge present,
	// "TLS certificate: No certificate found", and the hostname NXDOMAIN at the authoritative
	// nameservers. Let's Encrypt takes a few seconds; do it once, up front, and say so.
	certDomain := strings.TrimSuffix(publicHost, ".")
	emit("VDS_CERT", "requesting")
	if _, _, err := lc.CertPair(ctx, certDomain); err != nil {
		// Not fatal on its own — a cert may already exist in TSNET_DIR from an earlier run, and the
		// funnel listener below is the real test. Report it so the UI can explain a failure.
		emit("VDS_CERT_ERR", err.Error())
	} else {
		emit("VDS_CERT", "ok")
	}

	// Funnel: public 443 → local backend. TLS is terminated on THIS machine (the cert lives in
	// TSNET_DIR), so the relay only sees encrypted bytes.
	//
	// A brand-new personal tailnet has Funnel switched off, and the first ListenFunnel then fails
	// with a message containing the admin-console URL that turns it on. That is a ONE-CLICK fix the
	// user performs in a browser — so report it and keep retrying instead of dying: the moment they
	// flip the switch the tunnel comes up on its own, with no "start the app again" step.
	var ln net.Listener
	var lastErr string
	for attempt := 0; ; attempt++ {
		ln, err = s.ListenFunnel("tcp", ":443")
		if err == nil {
			break
		}
		// Only on change: the parent turns every event into a status write, and repeating the same
		// "still not enabled" forty times says nothing new.
		if err.Error() != lastErr {
			lastErr = err.Error()
			emit("VDS_FUNNEL_ERR", lastErr)
		}
		if attempt >= 40 { // ~10 minutes of patience, then stop burning cycles
			log.Fatalf("funnel listen: %v", err)
		}
		time.Sleep(15 * time.Second)
	}
	target, _ := url.Parse("http://127.0.0.1:" + localPort)
	emit("VDS_FUNNEL", "up")
	log.Fatal(http.Serve(ln, httputil.NewSingleHostReverseProxy(target)))
}

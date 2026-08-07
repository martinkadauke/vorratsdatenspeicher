// VDS remote-access sidecar: an EMBEDDED Tailscale node (tsnet) — no system Tailscale install,
// no admin, no OS prompt. Compiled once into a small binary that ships inside the VDS installer
// (like the Postgres/searxng sidecars). It exposes the local VDS backend to the internet via
// Tailscale Funnel: a stable HTTPS *.ts.net URL whose TLS terminates HERE, so Tailscale only ever
// relays ciphertext. The interactive login URL is printed for the Electron window to open in-app
// ("Mit Google anmelden") — the user never leaves VDS.
//
// Parent contract (stdout, one key=value line per event):
//   VDS_AUTH_URL=<url>     login needed → open this in the VDS window
//   VDS_PUBLIC_URL=<url>   node is up → the https://…ts.net address (for the connect-phone QR)
//   VDS_FUNNEL=up          funnel serving; traffic proxies to the local backend
//
// Env: VDS_LOCAL_PORT (backend port, required) · TSNET_DIR (state dir, persists login) ·
//      TS_HOSTNAME (node name).
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

func emit(key, val string) {
	fmt.Printf("%s=%s\n", key, val)
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
	host := os.Getenv("TS_HOSTNAME")
	if host == "" {
		host = "vorratsdatenspeicher"
	}

	s := &tsnet.Server{
		Dir:      dir,
		Hostname: host,
		// Scan tsnet's own logs for the interactive auth URL and hand it to the parent, which
		// opens it inside the VDS window. Everything else stays quiet.
		Logf: func(format string, args ...any) {
			line := fmt.Sprintf(format, args...)
			if i := strings.Index(line, "https://login.tailscale.com/"); i >= 0 {
				emit("VDS_AUTH_URL", strings.Fields(line[i:])[0])
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
	for {
		st, err := lc.Status(ctx)
		if err == nil && st != nil && st.BackendState == "Running" && st.Self != nil {
			emit("VDS_PUBLIC_URL", "https://"+strings.TrimSuffix(st.Self.DNSName, "."))
			break
		}
		time.Sleep(time.Second)
	}

	// Funnel: public 443 → local backend. TLS is terminated on THIS machine (the cert lives in
	// TSNET_DIR), so the relay only sees encrypted bytes.
	ln, err := s.ListenFunnel("tcp", ":443")
	if err != nil {
		log.Fatalf("funnel listen: %v", err)
	}
	target, _ := url.Parse("http://127.0.0.1:" + localPort)
	emit("VDS_FUNNEL", "up")
	log.Fatal(http.Serve(ln, httputil.NewSingleHostReverseProxy(target)))
}

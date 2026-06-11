# Deployment: Docker Swarm auf Proxmox + GitHub Actions CI/CD

```
git push → GitHub Actions baut Image → ghcr.io → self-hosted Runner (vds-1)
         → docker stack deploy → Rolling Update über 3 VMs → VIP 192.168.1.240
```

## Architektur

| Was | Wo |
|---|---|
| vds-1 (Swarm-Manager, CI-Runner) | VM 241 auf **kadaukevox** (USV!) — 192.168.1.241 |
| vds-2 (Swarm-Manager) | VM 242 auf **kadaukeprox** — 192.168.1.242 |
| vds-3 (Swarm-Manager) | VM 243 auf **kadaukemox** — 192.168.1.243 |
| Virtuelle IP (keepalived) | **192.168.1.250** → darauf zeigt NPM |
| App | 2 Replicas, Port 8766 via Routing Mesh auf allen Nodes |
| Postgres, Ollama, SearXNG, Belege-Fotos | bleiben auf Unraid (192.168.1.238) |

## Einmaliges Setup

1. **NPM auf Unraid** serviert `/receipts/*` direkt aus dem Filesystem
   (Custom location im Proxy-Host; Container braucht die Fotos nicht).

2. **VMs erstellen** — auf jedem Proxmox-Node (Web-UI → Shell), Script aus
   `deploy/proxmox/create-vm.sh` einfügen und ausführen:
   ```bash
   # kadaukevox:   VMID=241 NAME=vds-1 IP=192.168.1.241 bash create-vm.sh
   # kadaukeprox:  VMID=242 NAME=vds-2 IP=192.168.1.242 bash create-vm.sh
   # kadaukemox:   VMID=243 NAME=vds-3 IP=192.168.1.243 bash create-vm.sh
   # Falls pvesm status "local-zfs" zeigt: zusätzlich STORAGE=local-zfs
   ```

3. **VMs einrichten** — per SSH in jede VM (`ssh vds@192.168.1.24x`, Passwort siehe Script):
   ```bash
   # vds-1:        ROLE=manager-1 bash setup-vm.sh
   # vds-2, vds-3: ROLE=manager   bash setup-vm.sh  → danach Join-Befehl von vds-1 ausführen
   ```

4. **GitHub-Secrets setzen** (Repo → Settings → Secrets and variables → Actions):
   - `DATABASE_URL` — postgres://…@192.168.1.238:5432/…
   - `JWT_SECRET` — `openssl rand -hex 32`
   - `INTERNAL_SECRET` — `openssl rand -hex 16`

5. **Runner installieren** (auf vds-1, Token vorher per `gh api` holen — siehe Script):
   ```bash
   RUNNER_TOKEN=... bash install-runner.sh
   ```

6. **NPM**: neuer Proxy Host → `vds.giziko.online` → `192.168.1.250:8766`.

## Ab dann

- **Deploy**: `git push` auf main. Fertig. (~3-4 min bis live)
- **Rollback**: `git revert <commit> && git push` — oder auf vds-1: `docker service rollback vds_app`
- **Status**: `docker service ps vds_app` auf einem Manager
- **Logs**: `docker service logs -f vds_app`

## HA-Eigenschaften

- Node-Ausfall: Swarm verschiebt Replicas automatisch, keepalived schwenkt die VIP — App bleibt erreichbar.
- Update-Ausfall: `failure_action: rollback` + Healthcheck (`/api/health` prüft auch die DB-Verbindung).
- Single Point of Failure bleibt: Postgres/Unraid. (Bewusste Entscheidung, Daten-Layer-HA ist ein eigenes Projekt.)

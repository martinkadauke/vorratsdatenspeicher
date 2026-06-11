#!/bin/bash
# In JEDER der drei VMs ausführen (per SSH als User vds):
#   ROLE=manager-1 bash setup-vm.sh      # vds-1 (192.168.1.241, kadaukevox)
#   ROLE=manager   bash setup-vm.sh      # vds-2 und vds-3
#
# Installiert: Docker, NFS-Mount für Belege, keepalived (VIP 192.168.1.240)
set -euo pipefail

ROLE="${ROLE:?ROLE=manager-1 oder ROLE=manager}"
VIP="${VIP:-192.168.1.250}"

echo ">> Docker installieren..."
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

echo ">> Pakete für VIP-Failover..."
sudo apt-get install -y -qq keepalived

echo ">> keepalived konfigurieren (VIP ${VIP})..."
PRIORITY=100
[ "$ROLE" = "manager-1" ] && PRIORITY=150
IFACE=$(ip -o -4 route show to default | awk '{print $5}')
sudo tee /etc/keepalived/keepalived.conf > /dev/null <<EOF
vrrp_instance VDS {
    state BACKUP
    interface ${IFACE}
    virtual_router_id 66
    priority ${PRIORITY}
    advert_int 1
    virtual_ipaddress {
        ${VIP}/24
    }
}
EOF
sudo systemctl enable --now keepalived

if [ "$ROLE" = "manager-1" ]; then
  echo ">> Swarm initialisieren..."
  MYIP=$(hostname -I | awk '{print $1}')
  sudo docker swarm init --advertise-addr "$MYIP" || true
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo "Join-Befehl für vds-2 und vds-3 (als MANAGER joinen):"
  sudo docker swarm join-token manager | grep 'docker swarm join'
  echo "════════════════════════════════════════════════════════"
else
  echo ""
  echo ">> Jetzt den Join-Befehl von vds-1 hier ausführen (mit sudo)."
fi

echo ">> Fertig. Neu einloggen, damit die docker-Gruppe greift."

#!/bin/bash
# Erstellt eine Debian-12-Cloud-Init-VM für den Swarm.
# Auf JEDEM Proxmox-Node einmal ausführen (Web-UI → Node → Shell), mit anderen Werten:
#
#   kadaukevox:  VMID=241 NAME=vds-1 IP=192.168.1.241 bash create-vm.sh
#   kadaukeprox: VMID=242 NAME=vds-2 IP=192.168.1.242 bash create-vm.sh
#   kadaukemox:  VMID=243 NAME=vds-3 IP=192.168.1.243 bash create-vm.sh
#
# Optional: STORAGE=local-zfs (Default: local-lvm — mit `pvesm status` prüfen!)
set -euo pipefail

VMID="${VMID:?VMID setzen, z.B. VMID=241}"
NAME="${NAME:?NAME setzen, z.B. NAME=vds-1}"
IP="${IP:?IP setzen, z.B. IP=192.168.1.241}"
STORAGE="${STORAGE:-local-lvm}"
GATEWAY="${GATEWAY:-192.168.1.1}"
MEMORY="${MEMORY:-2048}"
CORES="${CORES:-2}"
DISK="${DISK:-24}"
CIUSER="${CIUSER:-vds}"
CIPASS="${CIPASS:-vds-setup-2026}"   # nach dem Setup ändern oder SSH-Key nutzen

IMG=/var/lib/vz/template/iso/debian-12-genericcloud-amd64.qcow2
if [ ! -f "$IMG" ]; then
  echo ">> Lade Debian 12 Cloud-Image..."
  wget -q --show-progress -O "$IMG" \
    https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2
fi

echo ">> Erstelle VM $VMID ($NAME) auf $STORAGE..."
qm create "$VMID" --name "$NAME" --memory "$MEMORY" --cores "$CORES" \
  --net0 virtio,bridge=vmbr0 --agent enabled=1 --ostype l26
qm importdisk "$VMID" "$IMG" "$STORAGE"
qm set "$VMID" --scsihw virtio-scsi-pci --scsi0 "$STORAGE:vm-$VMID-disk-0"
qm disk resize "$VMID" scsi0 "${DISK}G"
qm set "$VMID" --ide2 "$STORAGE:cloudinit" --boot order=scsi0 --serial0 socket --vga serial0
qm set "$VMID" --ciuser "$CIUSER" --cipassword "$CIPASS" \
  --ipconfig0 "ip=${IP}/24,gw=${GATEWAY}" --nameserver 192.168.1.1
qm set "$VMID" --onboot 1
qm start "$VMID"

echo ""
echo ">> Fertig. VM bootet — in ~30s erreichbar:  ssh ${CIUSER}@${IP}  (Passwort: ${CIPASS})"
echo ">> Dann dort deploy/proxmox/setup-vm.sh ausführen."

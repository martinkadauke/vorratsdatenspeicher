#!/bin/bash
# GitHub-Actions-Runner auf vds-1 installieren (führt die Deploys aus).
# Vorher auf dem Dev-Rechner einen Registrierungs-Token holen:
#   gh api -X POST repos/martinkadauke/vorratsdatenspeicher/actions/runners/registration-token -q .token
#
#   RUNNER_TOKEN=<token> bash install-runner.sh
set -euo pipefail

RUNNER_TOKEN="${RUNNER_TOKEN:?RUNNER_TOKEN setzen (siehe Kommentar oben)}"
REPO_URL="${REPO_URL:-https://github.com/martinkadauke/vorratsdatenspeicher}"
RUNNER_VERSION="2.321.0"

mkdir -p ~/actions-runner && cd ~/actions-runner
if [ ! -f config.sh ]; then
  curl -sL -o runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
  tar xzf runner.tar.gz && rm runner.tar.gz
fi

./config.sh --unattended --url "$REPO_URL" --token "$RUNNER_TOKEN" \
  --name "vds-1-runner" --labels swarm --replace

sudo ./svc.sh install "$USER"
sudo ./svc.sh start
echo ">> Runner läuft. Check: https://github.com/martinkadauke/vorratsdatenspeicher/settings/actions/runners"

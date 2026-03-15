#!/bin/bash
# MTG Agent installer / updater
# Usage: bash install-agent.sh [AGENT_TOKEN]
set -e

TOKEN="${1:-mtg-agent-secret}"
INSTALL_DIR="/opt/mtg-agent"
RAW="https://raw.githubusercontent.com/MaksimTMB/mtg-adminpanel/dev/mtg-agent"

echo "==> MTG Agent install/update..."
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

curl -fsSL "$RAW/main.py"            -o main.py
curl -fsSL "$RAW/docker-compose.yml" -o docker-compose.yml

echo "AGENT_TOKEN=${TOKEN}" > .env

docker compose down 2>/dev/null || true
docker compose up -d

echo ""
echo "==> Done. Waiting for agent..."
sleep 8
curl -s -H "x-agent-token: ${TOKEN}" http://localhost:8081/health && echo " <- health OK" || echo "WARNING: agent not responding yet, check: docker logs mtg-agent"

#!/bin/bash
set +H

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="/opt/mtg-adminpanel"

print_header() {
    clear
    echo -e "${RED}╔══════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║${WHITE}      🗑️   MTG AdminPanel — Uninstall            ${NC}${RED}║${NC}"
    echo -e "${RED}╚══════════════════════════════════════════════════╝${NC}"
    echo ""
}

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}❌ Запусти скрипт от root: sudo bash uninstall.sh${NC}"
    exit 1
fi

print_header

echo -e "${YELLOW}⚠️  Это удалит:${NC}"
echo -e "  • Контейнер mtg-panel"
echo -e "  • Директорию ${CYAN}$INSTALL_DIR${NC} (включая базу данных!)"
echo -e "  • Nginx конфиг mtg-panel (если есть)"
echo -e "  • Systemd сервис mtg-adminpanel"
echo ""
echo -ne "${RED}Ты уверен? Все данные будут удалены! (y/N)${NC}: "
IFS= read -r CONFIRM < /dev/tty

if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
    echo -e "${DIM}Отменено.${NC}"
    exit 0
fi

echo ""

# Останавливаем и удаляем контейнер
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${CYAN}▶ Останавливаем панель...${NC}"
    cd "$INSTALL_DIR" && docker compose down 2>/dev/null
    echo -e "${GREEN}✅ Контейнер остановлен${NC}"
fi

# Удаляем директорию
echo -e "${CYAN}▶ Удаляем файлы...${NC}"
rm -rf "$INSTALL_DIR"
echo -e "${GREEN}✅ Директория удалена${NC}"

# Удаляем systemd сервис
if [ -f "/etc/systemd/system/mtg-adminpanel.service" ]; then
    echo -e "${CYAN}▶ Удаляем systemd сервис...${NC}"
    systemctl disable mtg-adminpanel 2>/dev/null
    rm -f /etc/systemd/system/mtg-adminpanel.service
    systemctl daemon-reload
    echo -e "${GREEN}✅ Сервис удалён${NC}"
fi

# Удаляем Nginx конфиг
if [ -f "/etc/nginx/sites-available/mtg-panel" ]; then
    echo -e "${CYAN}▶ Удаляем Nginx конфиг...${NC}"
    rm -f /etc/nginx/sites-available/mtg-panel
    rm -f /etc/nginx/sites-enabled/mtg-panel
    systemctl reload nginx 2>/dev/null
    echo -e "${GREEN}✅ Nginx конфиг удалён${NC}"
fi

# Удаляем Docker образ
echo -e "${CYAN}▶ Удаляем Docker образ...${NC}"
docker rmi mtg-adminpanel-mtg-panel 2>/dev/null || true
echo -e "${GREEN}✅ Образ удалён${NC}"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${WHITE}        ✅  MTG AdminPanel удалён!               ${NC}${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""

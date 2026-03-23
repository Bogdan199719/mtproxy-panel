#!/bin/bash
set -e
set +H
cd /tmp

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; WHITE='\033[1;37m'; DIM='\033[2m'; NC='\033[0m'

REPO="https://github.com/Bogdan199719/mtproxy-panel.git"
INSTALL_DIR="/opt/mtg-adminpanel"
REPO_SLUG="${REPO#https://github.com/}"
REPO_SLUG="${REPO_SLUG%.git}"

p_ok()   { echo -e "${GREEN}✅ $1${NC}"; }
p_err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
p_warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
p_step() { echo -e "${CYAN}▶ $1${NC}"; }

[ "$EUID" -ne 0 ] && p_err "Запусти от root: sudo bash install.sh"

clear
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${WHITE}    🔒  MTG AdminPanel — Установка      ${NC}${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ── Сбор параметров ──────────────────────────────────────────
while true; do
    echo -ne "${WHITE}Логин для входа в панель${NC}: "
    IFS= read -r ADMIN_USER < /dev/tty
    [ ${#ADMIN_USER} -ge 3 ] && break
    p_warn "Минимум 3 символа"
done

while true; do
    echo -ne "${WHITE}Пароль${NC} ${DIM}(минимум 8 символов)${NC}: "
    IFS= read -rs ADMIN_PASS < /dev/tty; echo
    [ ${#ADMIN_PASS} -ge 8 ] && break
    p_warn "Минимум 8 символов"
done

AUTH_TOKEN=$(openssl rand -hex 32 2>/dev/null || cat /proc/sys/kernel/random/uuid | tr -d '-')

echo -ne "${WHITE}Порт панели${NC} ${DIM}[3000]${NC}: "
IFS= read -r PORT_IN < /dev/tty
PORT=${PORT_IN:-3000}

echo ""
echo -e "${WHITE}SSL?${NC}"
echo -e "  ${CYAN}[1]${NC} Нет (http://IP:$PORT)"
echo -e "  ${CYAN}[2]${NC} Да — Nginx + Let's Encrypt"
echo -ne "  Выбор [1]: "
IFS= read -r SSL < /dev/tty; SSL=${SSL:-1}

DOMAIN="" EMAIL=""
if [ "$SSL" = "2" ]; then
    echo -ne "${WHITE}Домен${NC}: "; IFS= read -r DOMAIN < /dev/tty
    echo -ne "${WHITE}Email для Let's Encrypt${NC}: "; IFS= read -r EMAIL < /dev/tty
fi

# ── Подтверждение ────────────────────────────────────────────
echo ""
echo -e "${DIM}─────────────────────────────────────────${NC}"
echo -e "  Директория:  ${CYAN}$INSTALL_DIR${NC}"
echo -e "  Логин:       ${CYAN}$ADMIN_USER${NC}"
echo -e "  Порт:        ${CYAN}$PORT${NC}"
[ -n "$DOMAIN" ] && echo -e "  Домен:       ${CYAN}$DOMAIN${NC}"
echo -e "${DIM}─────────────────────────────────────────${NC}"
echo -ne "${WHITE}Установить? (y/N)${NC}: "
IFS= read -r CONFIRM < /dev/tty
[[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]] && { echo "Отменено."; exit 0; }
echo ""

# ── Зависимости ──────────────────────────────────────────────
p_step "Обновление системы..."
apt-get update -qq && apt-get install -y -qq curl wget git ufw

# ── Docker ───────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
    p_step "Установка Docker..."
    curl -fsSL https://get.docker.com | sh || p_err "Не удалось установить Docker"
    p_ok "Docker установлен"
else
    p_ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

# ── Клонирование ─────────────────────────────────────────────
p_step "Загрузка MTG AdminPanel..."
if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    git fetch origin "$BRANCH"
    git merge --ff-only "origin/$BRANCH"
elif [ -d "$INSTALL_DIR" ]; then
    p_err "Директория $INSTALL_DIR уже существует и не является git-репозиторием. Проверь данные и удали её вручную перед установкой."
else
    git clone -q "$REPO" "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/ssh_keys"
p_ok "Репозиторий загружен"

# ── Конфигурация ─────────────────────────────────────────────
p_step "Создание конфигурации..."
PANEL_URL="http://$(curl -s -4 ifconfig.me 2>/dev/null || echo localhost):$PORT"
[ -n "$DOMAIN" ] && PANEL_URL="https://$DOMAIN"

cat > "$INSTALL_DIR/.env" << ENV
ADMIN_USERNAME=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASS
AUTH_TOKEN=$AUTH_TOKEN
AGENT_TOKEN=$(openssl rand -hex 20)
PORT=$PORT
DATA_DIR=/data
PANEL_URL=$PANEL_URL
REPO_SLUG=$REPO_SLUG
ENV
p_ok "Конфигурация создана"

# ── Запуск ───────────────────────────────────────────────────
p_step "Сборка и запуск панели..."
cd "$INSTALL_DIR"
docker compose up -d --build 2>&1 | tail -3
sleep 4

docker ps | grep -q mtg-panel && p_ok "Панель запущена" || p_err "Ошибка запуска! docker logs mtg-panel"

# ── UFW фаервол ──────────────────────────────────────────────
p_step "Настройка фаервола..."
ufw allow ssh > /dev/null
ufw allow $PORT/tcp comment "MTG Panel" > /dev/null
ufw --force enable > /dev/null
p_ok "UFW настроен"

# ── Nginx + SSL ──────────────────────────────────────────────
if [ "$SSL" = "2" ] && [ -n "$DOMAIN" ]; then
    p_step "Nginx + Let's Encrypt для $DOMAIN..."
    apt-get install -y -qq nginx certbot python3-certbot-nginx

    cat > /etc/nginx/sites-available/mtg-panel << NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://localhost:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
    ln -sf /etc/nginx/sites-available/mtg-panel /etc/nginx/sites-enabled/
    nginx -t -q && systemctl reload nginx
    certbot --nginx -d "$DOMAIN" --email "$EMAIL" --agree-tos --non-interactive -q \
        && p_ok "SSL настроен" || p_warn "SSL не удалось получить — домен указывает на этот IP?"
fi

# ── Итог ─────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${GREEN}       ✅  Установка завершена!          ${NC}${CYAN}║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""
if [ -n "$DOMAIN" ]; then
    echo -e "  🌐  ${CYAN}https://$DOMAIN${NC}"
else
    IP=$(curl -s -4 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    echo -e "  🌐  ${CYAN}http://$IP:$PORT${NC}"
fi
echo -e "  👤  Логин:  ${CYAN}$ADMIN_USER${NC}"
echo -e "  🔑  Пароль: ${CYAN}$ADMIN_PASS${NC}"
echo ""
echo -e "${DIM}  docker logs mtg-panel -f      — логи${NC}"
echo -e "${DIM}  docker restart mtg-panel      — перезапуск${NC}"
echo ""

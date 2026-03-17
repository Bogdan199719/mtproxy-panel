# MTG AdminPanel

Веб-панель управления MTProto прокси серверами (MTG v2). Управляй неограниченным количеством нод и клиентов через единый интерфейс.

![Version](https://img.shields.io/badge/version-2.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-20-brightgreen)
![Docker](https://img.shields.io/badge/docker-required-blue)

---

## Возможности

- **Мультинодовое управление** — добавляй ноды по SSH, панель сама устанавливает всё необходимое
- **Авто-оптимизация нод** — BBR TCP, UFW фаервол, Docker log limits, ulimits — всё при подготовке сервера
- **Клиенты** — создание/удаление MTG прокси контейнеров, QR-коды, ссылки `tg://proxy`
- **Биллинг** — дата истечения, автоостановка при просрочке, автозапуск при продлении
- **Лимит устройств** — автостоп при превышении одновременных подключений
- **Автосброс трафика** — ежедневно / ежемесячно / ежегодно
- **MTG Agent** — Python FastAPI агент на каждой ноде, реальные метрики без SSH
- **2FA (TOTP)** — двухфакторная аутентификация (Google Authenticator и др.)
- **Безопасность** — rate limiting, security headers, валидация входных данных, JSX компилируется при сборке

---

## Быстрая установка

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/YOUR_USERNAME/mtg-adminpanel/main/install.sh)
```

> Замени `YOUR_USERNAME` на свой GitHub username

---

## Требования

**Панель:**
- Ubuntu 20.04+ / Debian 11+
- Docker + Docker Compose
- Порт 3000 (или любой другой)

**Ноды (устанавливается автоматически через панель):**
- Ubuntu 20.04+ / Debian 11+
- SSH доступ (пароль или ключ)
- Минимум 1 vCPU, 512 MB RAM

---

## Установка вручную

### 1. Клонировать

```bash
git clone https://github.com/YOUR_USERNAME/mtg-adminpanel.git /opt/mtg-adminpanel
cd /opt/mtg-adminpanel
```

### 2. Создать конфигурацию

```bash
cp .env.example .env
nano .env
```

### 3. Запустить

```bash
docker compose up -d
```

### 4. Nginx + SSL (опционально)

```bash
apt install -y nginx certbot python3-certbot-nginx
certbot --nginx -d panel.example.com
```

Конфиг `/etc/nginx/sites-available/panel`:

```nginx
server {
    listen 80;
    server_name panel.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name panel.example.com;
    ssl_certificate /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Добавление ноды

1. Панель → **Ноды** → **Добавить ноду**
2. Введи IP, SSH логин/пароль (или ключ)
3. Нажми **Добавить и подготовить сервер**

Панель автоматически установит Docker, MTG Agent, настроит BBR TCP, UFW, системные лимиты и определит характеристики сервера (CPU/RAM).

---

## Переменные окружения

| Переменная | Описание | Обязательно |
|-----------|----------|-------------|
| `ADMIN_USERNAME` | Логин для входа в панель | ✅ |
| `ADMIN_PASSWORD` | Пароль для входа в панель | ✅ |
| `AUTH_TOKEN` | Внутренний токен сессии | ✅ |
| `AGENT_TOKEN` | Токен MTG Agent (должен совпадать на нодах) | ✅ |
| `PORT` | Порт панели | По умолчанию `3000` |
| `PANEL_URL` | URL панели (для CORS) | По умолчанию `http://localhost:3000` |
| `DATA_DIR` | Путь к базе данных | По умолчанию `/data` |

---

## Структура проекта

```
mtg-adminpanel/
├── backend/
│   └── src/
│       ├── app.js          # Express API, фоновые задачи
│       ├── db.js           # SQLite схема и миграции
│       ├── ssh.js          # SSH + MTG Agent клиент
│       └── totp.js         # TOTP 2FA
├── public/
│   └── index.html          # React SPA
├── mtg-agent/
│   ├── main.py             # FastAPI агент
│   ├── docker-compose.yml
│   └── install-agent.sh
├── build-jsx.js            # Компиляция JSX при Docker build
├── docker-compose.yml
├── Dockerfile
├── install.sh
├── .env.example
└── README.md
```

---

## API

### Авторизация

```
POST /api/login   { "username": "...", "password": "..." }
→ { "token": "..." }
```

Все остальные запросы: заголовок `x-auth-token: TOKEN`

### Ноды

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/nodes` | Список нод |
| POST | `/api/nodes` | Создать |
| PUT | `/api/nodes/:id` | Обновить |
| DELETE | `/api/nodes/:id` | Удалить |
| POST | `/api/nodes/:id/setup-node` | Подготовить сервер |
| GET | `/api/nodes/:id/check` | Проверить SSH/Agent |
| GET | `/api/status` | Статус всех нод |
| GET | `/api/counts` | Количество клиентов (SQLite) |

### Клиенты

| Метод | URL | Описание |
|-------|-----|----------|
| GET | `/api/nodes/:id/users` | Список с метриками |
| POST | `/api/nodes/:id/users` | Создать |
| PUT | `/api/nodes/:id/users/:name` | Обновить |
| DELETE | `/api/nodes/:id/users/:name` | Удалить |
| POST | `/api/nodes/:id/users/:name/stop` | Остановить |
| POST | `/api/nodes/:id/users/:name/start` | Запустить |
| POST | `/api/nodes/:id/users/:name/reset-traffic` | Сбросить трафик |

---

## Обновление

```bash
cd /opt/mtg-adminpanel
git pull
docker compose down && docker compose up -d --build
```

---

## Changelog

### v2.1.0
- Авто-оптимизация ноды при подготовке (BBR, UFW, ulimits, Docker log limits, CPU/RAM detection)
- JSX компилируется при Docker build (убран babel-standalone из браузера)
- Новый endpoint `/api/counts` — подсчёт без SSH
- Rate limiting на TOTP
- Исправлена бесконечная загрузка страницы клиентов (`!_userCount` bug)
- Исправлена временная зона при редактировании дат
- Security headers, маскировка токена в логах, валидация имён

### v2.0.0
- MTG Agent, лимит устройств, автосброс трафика
- Авторизация логин/пароль, 2FA TOTP
- Авто-установка нод через SSH
- Биллинг: дата истечения, автостоп/автозапуск

---

## Лицензия

MIT

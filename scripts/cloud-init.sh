#!/usr/bin/env bash
# 阿里云 ECS 一键部署 QQ 农场 Bot（公网访问版）
# 适配 Ubuntu 22.04 / 24.04（预装 Docker 镜像也可）
#
# 用法：
#   sudo bash scripts/cloud-init.sh
#
# 流程：
#   1. 系统检查 + 时区
#   2. 防火墙（放行 22 和 3007；抓包端口不放行）
#   3. 安装 Docker + docker compose 插件（如未安装）
#   4. 克隆仓库到 /opt/qq-farm-bot
#   5. 生成 .env（含随机管理员密码）
#   6. 构建并启动容器，等待健康检查
#   7. 打印公网访问地址

set -Eeuo pipefail

# ============ 配置 ============
INSTALL_DIR="/opt/qq-farm-bot"
REPO_URL="https://github.com/CGuys/qq_farm_bot.git"
BOT_PORT=3007
TIMEZONE="Asia/Shanghai"

# ============ 日志 ============
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[INIT]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step() { echo -e "\n${BLUE}=== $* ===${NC}"; }

# ============ 1. 前置检查 ============
step "1. 前置检查"

if [[ $EUID -ne 0 ]]; then
    err "请用 root 或 sudo 执行：sudo bash $0"
    exit 1
fi

if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    log "系统：$ID $VERSION_ID"
    if [[ "$ID" != "ubuntu" && "$ID" != "debian" ]]; then
        warn "未经验证的系统，建议 Ubuntu 22.04/24.04"
    fi
fi

# ============ 2. 时区 + 基础工具 ============
step "2. 时区与基础工具"

timedatectl set-timezone "$TIMEZONE" 2>/dev/null || {
    apt-get update -y >/dev/null
    apt-get install -y tzdata >/dev/null
    timedatectl set-timezone "$TIMEZONE"
}
log "时区：$TIMEZONE"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git jq ufw ca-certificates openssl

# ============ 3. 防火墙 ============
step "3. 防火墙"

ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 3007/tcp
# 抓包端口池 18000-18999 不放行公网，需要时走 Tailscale
ufw --force enable >/dev/null
log "防火墙已启用：放行 22/tcp 和 3007/tcp"
warn "⚠️  阿里云安全组也必须放行 3007/tcp，否则公网仍无法访问"
warn "    控制台 → ECS → 安全组 → 配置规则 → 入方向 → 添加 3007/tcp 0.0.0.0/0"

# ============ 4. Docker ============
step "4. Docker"

if ! command -v docker &>/dev/null; then
    log "安装 Docker（官方脚本）"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
else
    log "Docker 已安装：$(docker --version)"
fi

if ! docker compose version &>/dev/null; then
    apt-get install -y docker-compose-plugin
fi
log "docker compose：$(docker compose version)"

# ============ 5. 克隆/更新仓库 ============
step "5. 仓库"

if [[ -d "$INSTALL_DIR/.git" ]]; then
    log "更新已有仓库 $INSTALL_DIR"
    git -C "$INSTALL_DIR" pull --ff-only
else
    log "克隆仓库到 $INSTALL_DIR"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ============ 6. 生成 .env ============
step "6. .env 文件"

ENV_FILE="$INSTALL_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
    log "复用已有 $ENV_FILE（如需重置请先删除它）"
else
    ADMIN_USER="admin"
    ADMIN_PASS=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
    cat > "$ENV_FILE" <<EOF
# QQ 农场生产环境变量（不要提交到 git；本文件权限 600）
FARM_ADMIN_USERNAME=$ADMIN_USER
FARM_ADMIN_PASSWORD=$ADMIN_PASS
# 抓包地址默认 auto；启用抓包时改为本机 Tailscale IP，例如：
# CAPTURE_ADVERTISE_IPS=100.x.x.x
CAPTURE_ADVERTISE_IPS=auto
EOF
    chmod 600 "$ENV_FILE"
    warn "已生成管理员账号（仅显示一次，请立即记录并登录后修改）："
    echo "----------------------------------------"
    echo "  用户名：$ADMIN_USER"
    echo "  密码：  $ADMIN_PASS"
    echo "----------------------------------------"
fi

# ============ 7. 构建并启动 ============
step "7. 构建并启动容器"

log "首次会拉镜像并构建前端，约 3-10 分钟"
docker compose -f docker-compose.prod.yml up -d --build

# ============ 8. 健康检查 ============
step "8. 健康检查"

log "等待容器进入 healthy 状态（最多 150 秒）"
healthy=0
for i in $(seq 1 30); do
    status=$(docker inspect --format '{{.State.Health.Status}}' qq-farm-bot 2>/dev/null || echo "none")
    if [[ "$status" == "healthy" ]]; then
        log "健康检查通过"
        healthy=1
        break
    fi
    sleep 5
done
if [[ $healthy -eq 0 ]]; then
    warn "健康检查未通过（当前：$status），查看日志："
    echo "  docker compose -f docker-compose.prod.yml logs --tail=50"
fi

# ============ 9. 获取公网 IP ============
step "9. 公网访问地址"

# 优先从阿里云元数据获取公网 IP，失败则用外网探测
PUBLIC_IP=""
if command -v curl &>/dev/null; then
    # 阿里云 ECS 元数据服务
    PUBLIC_IP=$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)
    if [[ -z "$PUBLIC_IP" ]]; then
        PUBLIC_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)
    fi
fi

if [[ -n "$PUBLIC_IP" ]]; then
    log "本机公网 IP：$PUBLIC_IP"
    echo ""
    echo "  📱 访问地址：http://$PUBLIC_IP:$BOT_PORT"
    echo ""
    warn "如果打不开，请确认阿里云安全组已放行 3007/tcp 入方向"
else
    warn "无法自动获取公网 IP，请在阿里云控制台查看实例公网 IP"
    echo "  访问地址格式：http://<公网IP>:$BOT_PORT"
fi

# ============ 10. 完成 ============
echo ""
echo "================================================"
log "部署完成"
echo "------------------------------------------------"
echo "仓库目录：$INSTALL_DIR"
echo "数据目录：$INSTALL_DIR/data  ← 备份这个"
echo "环境变量：$INSTALL_DIR/.env"
echo "------------------------------------------------"
echo "常用命令："
echo "  查看日志： cd $INSTALL_DIR && docker compose -f docker-compose.prod.yml logs -f"
echo "  重启服务： cd $INSTALL_DIR && docker compose -f docker-compose.prod.yml restart"
echo "  停止服务： cd $INSTALL_DIR && docker compose -f docker-compose.prod.yml down"
echo "  更新代码： cd $INSTALL_DIR && git pull && docker compose -f docker-compose.prod.yml up -d --build"
echo "------------------------------------------------"
warn "安全提醒："
warn "  1. 登录面板后立即修改管理员强密码"
warn "  2. 不要开放 18000-18999 抓包端口到公网"
warn "  3. 阿里云免费试用务必设置到期自动释放，避免欠费"
warn "     控制台 → ECS → 实例 → 更多 → 实例设置 → 释放设置"
warn "  4. 建议长期部署前面套 Nginx + HTTPS + IP 白名单"
echo "================================================"

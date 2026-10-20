#!/usr/bin/env bash
# 服务器端部署脚本：由 .github/workflows/deploy.yml 通过 ssh 以 stdin 方式执行。
# 不要在本地直接运行 —— 它会重置目标目录的代码。
#
# 依赖环境变量（由 workflow 注入）：
#   REPO_URL      仓库地址
#   BRANCH        部署分支
#   DEPLOY_PATH   服务器上的部署目录
#   COMPOSE_FILE  compose 文件名
set -euo pipefail

: "${REPO_URL:?缺少环境变量 REPO_URL}"
: "${BRANCH:?缺少环境变量 BRANCH}"
: "${DEPLOY_PATH:?缺少环境变量 DEPLOY_PATH}"
: "${COMPOSE_FILE:?缺少环境变量 COMPOSE_FILE}"

HEALTH_URL="http://127.0.0.1:3007/"

cd "$DEPLOY_PATH"

echo "=== 部署前版本 ==="
git log --oneline -1 || true

echo "=== 对齐远端仓库 ${REPO_URL} (${BRANCH}) ==="
git remote set-url origin "$REPO_URL"
# 上游曾重写过历史，服务器上的旧克隆与远端无共同祖先，
# 因此必须 reset --hard 对齐，不能用 git pull --ff-only。
git fetch --prune --depth 1 origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
git reset --hard "origin/${BRANCH}"

echo "=== 部署后版本 ==="
git log --oneline -1

# .env 与 ./data 均为未跟踪文件，reset --hard 不会删除它们
if [ ! -f .env ]; then
  echo "错误：${DEPLOY_PATH}/.env 不存在（缺少 FARM_ADMIN_USERNAME / FARM_ADMIN_PASSWORD），终止部署" >&2
  exit 1
fi

echo "=== 重建并启动容器 ==="
docker compose -f "$COMPOSE_FILE" up -d --build

echo "=== 容器状态 ==="
docker compose -f "$COMPOSE_FILE" ps

echo "=== 健康检查 ==="
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" || true)
  if [ "$code" = "200" ]; then
    echo "健康检查通过（HTTP 200，第 ${i} 次尝试）"
    exit 0
  fi
  sleep 5
done

echo "健康检查失败：150 秒内 ${HEALTH_URL} 未返回 200，输出最近日志：" >&2
docker compose -f "$COMPOSE_FILE" logs --tail=50 >&2 || true
exit 1

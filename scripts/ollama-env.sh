#!/bin/sh
# 登录时为 Ollama 设置提速用的环境变量，并确保 Ollama 带着这些变量运行。
# 由 scripts/setup-local-model.sh 复制到 ~/.ollama/ollama-env.sh，并通过 LaunchAgent 在每次登录时调用：
#   ollama-env.sh <并行段数> <模型常驻时间> <Ollama.app 路径>
# launchctl setenv 重启电脑后会失效，所以每次登录都要重新设置。

PARALLEL="${1:-4}"
KEEP_ALIVE="${2:-15m}"
APP_PATH="${3:-/Applications/Ollama.app}"

launchctl setenv OLLAMA_NUM_PARALLEL "$PARALLEL"   # 同时处理的段数
launchctl setenv OLLAMA_FLASH_ATTENTION 1          # 并行时更省内存
launchctl setenv OLLAMA_KEEP_ALIVE "$KEEP_ALIVE"   # 空闲多久后卸载模型

# 正则锚定整条命令行开头，只匹配从 Ollama.app 启动的进程，不会误伤命令行里恰好含有这个路径的终端或编辑器。
APP="^$APP_PATH/Contents/"
SERVER="^$APP_PATH/Contents/Resources/ollama serve\$"
log() { echo "$(date '+%F %T') $*"; }

has_settings() {
    command=$(ps eww -o command= -p "$1")
    for setting in "OLLAMA_NUM_PARALLEL=$PARALLEL" "OLLAMA_FLASH_ATTENTION=1" "OLLAMA_KEEP_ALIVE=$KEEP_ALIVE"; do
        echo "$command" | grep -Eq "(^| )$setting( |\$)" || return 1
    done
}

# 直接把设置交给新启动的 Ollama，不依赖 launchctl 变量传到 LaunchServices 的时机。
launch_with_settings() {
    open -ga "$APP_PATH" --env "OLLAMA_NUM_PARALLEL=$PARALLEL" --env OLLAMA_FLASH_ATTENTION=1 \
        --env "OLLAMA_KEEP_ALIVE=$KEEP_ALIVE" 2>/dev/null || open -ga "$APP_PATH"
}
# 进程退出后系统还要一会儿才登记 Ollama 已退出，马上重新打开会失败（LaunchServices 错误 -600）。
stop_ollama() {
    pkill -f "$APP"
    j=0
    while [ "$j" -lt 10 ] && pgrep -f "$APP" >/dev/null; do sleep 1; j=$((j + 1)); done
    sleep 2
}
server_ready() {
    k=0
    while [ "$k" -lt 20 ]; do
        PID=$(pgrep -f "$SERVER" | head -1)
        if [ -n "$PID" ] && has_settings "$PID"; then return 0; fi
        sleep 1
        k=$((k + 1))
    done
    return 1
}

# Ollama 可能是登录项，最多等 30 秒看它是否自行启动。
i=0
while [ "$i" -lt 30 ] && ! pgrep -f "$SERVER" >/dev/null; do sleep 1; i=$((i + 1)); done

PID=$(pgrep -f "$SERVER" | head -1)
if [ -z "$PID" ]; then
    log "Ollama 未运行，在后台启动"
    launch_with_settings
elif has_settings "$PID"; then
    log "Ollama 已带着环境变量运行"
    exit 0
else
    # 比本脚本先启动的 Ollama 读不到新变量，重启一次（此时通常还没加载模型）。
    log "Ollama 未读到当前设置，重启使其生效"
    stop_ollama
    launch_with_settings
fi

# 确认已按设置运行；启动失败或仍是旧设置时最多再重启两次。
attempt=1
until server_ready; do
    if [ "$attempt" -ge 3 ]; then
        log "Ollama 仍未按设置运行，请手动退出并重新打开 Ollama"
        exit 1
    fi
    attempt=$((attempt + 1))
    log "设置未生效，第 $attempt 次重启"
    stop_ollama
    launch_with_settings
done
log "Ollama 已按设置运行：同时处理 $PARALLEL 段，空闲 $KEEP_ALIVE 后卸载模型"

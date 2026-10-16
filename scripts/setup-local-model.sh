#!/bin/bash
# 一条命令配置插件的本地翻译模型（macOS）：
#   1. 检查并启动 Ollama；
#   2. 下载 Hunyuan-MT-7B：自动测速选择 Hugging Face 或国内镜像，校验 SHA-256 后导入 Ollama；
#   3. 按内存设置并行段数和模型常驻时间，安装 LaunchAgent，重启电脑后自动生效。
# 用法：scripts/setup-local-model.sh [--parallel 1-8] [--keep-alive 15m] [--mirror | --no-mirror]
#       scripts/setup-local-model.sh --uninstall    撤销提速设置和开机自启（保留模型）
# 可重复运行：已装好的步骤会跳过，修改参数后重新运行即可更新设置。
set -euo pipefail

MODEL='hf.co/mradermacher/Hunyuan-MT-7B-GGUF:Q5_K_M'   # 与插件弹窗里的默认模型名一致
GGUF_PATH='mradermacher/Hunyuan-MT-7B-GGUF/resolve/main/Hunyuan-MT-7B.Q5_K_M.gguf'
GGUF_SHA256='69e654ecfef7a12106da8fc0b4a7342f2d4334b0ee357303e71ef9dab8d9f6ce'
GGUF_SIZE=5371536384
LABEL='local.chrome-deepl-translator.ollama-env'
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_SCRIPT="$HOME/.ollama/ollama-env.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.ollama/logs/ollama-env.log"
DOWNLOAD_DIR="$HOME/.ollama/downloads"
API='http://127.0.0.1:11434'

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m注意：\033[0m%s\n' "$*" >&2; }
die() { printf '\033[1;31m错误：\033[0m%s\n' "$*" >&2; exit 1; }
api() { curl -s --noproxy '*' -m "${2:-3}" "$API$1"; }

PARALLEL=''
KEEP_ALIVE='15m'
MIRROR='auto'
UNINSTALL=0
while [ $# -gt 0 ]; do
    case "$1" in
        --parallel|--keep-alive)
            [ $# -ge 2 ] || die "$1 需要一个值"
            if [ "$1" = --parallel ]; then PARALLEL="$2"; else KEEP_ALIVE="$2"; fi
            shift 2 ;;
        --mirror) MIRROR='yes'; shift ;;
        --no-mirror) MIRROR='no'; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "未知参数：$1（用 --help 查看用法）" ;;
    esac
done

[ "$(uname -s)" = Darwin ] || die '本脚本只支持 macOS；其他系统请按 README 手动安装 Ollama 和模型'

APP_PATH=''
for candidate in /Applications/Ollama.app "$HOME/Applications/Ollama.app"; do
    if [ -d "$candidate" ]; then APP_PATH="$candidate"; break; fi
done
[ -n "$APP_PATH" ] || die '没有找到 Ollama.app，请先从 https://ollama.com/download 安装（或 brew install --cask ollama），打开一次后再运行本脚本'
OLLAMA="$APP_PATH/Contents/Resources/ollama"

wait_for_ollama() {
    local i
    for ((i = 0; i < $1; i++)); do
        if api /api/version >/dev/null; then return 0; fi
        sleep 1
    done
    return 1
}

# 检查 Ollama 服务进程的环境变量：server_env_has NAME=VALUE...，不带参数时检查三个提速变量都不存在。
server_env_has() {
    local pid command setting
    pid=$(pgrep -f "^$APP_PATH/Contents/Resources/ollama serve\$" | head -1 || true)
    [ -n "$pid" ] || return 1
    command=" $(ps eww -o command= -p "$pid") "
    if [ $# -eq 0 ]; then
        [[ "$command" != *" OLLAMA_NUM_PARALLEL="* && "$command" != *" OLLAMA_KEEP_ALIVE="* ]]
        return
    fi
    for setting in "$@"; do [[ "$command" == *" $setting "* ]] || return 1; done
}

if [ "$UNINSTALL" = 1 ]; then
    info '撤销提速设置和开机自启…'
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$ENV_SCRIPT"
    for name in OLLAMA_NUM_PARALLEL OLLAMA_FLASH_ATTENTION OLLAMA_KEEP_ALIVE; do launchctl unsetenv "$name"; done
    if pgrep -f "^$APP_PATH/Contents/" >/dev/null; then
        info '重启 Ollama，恢复默认设置…'
        pkill -f "^$APP_PATH/Contents/" || true
        sleep 5   # 等系统登记 Ollama 已退出，否则重新打开会失败
        open -ga "$APP_PATH"
        wait_for_ollama 60 || warn 'Ollama 没有自动重新打开，请手动打开'
        sleep 2
        if ! server_env_has; then warn 'Ollama 仍带着提速设置，下次登录后会恢复默认；也可手动退出并重新打开 Ollama'; fi
    fi
    info "完成。模型仍保留，如需删除：$OLLAMA rm $MODEL"
    exit 0
fi

# ---------- 1. 检查环境 ----------
MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
if [ -z "$PARALLEL" ]; then
    # 实测 M5/24GB：并行 4 段时模型约占 8.9GB，单段约 6.3GB。
    if [ "$MEM_GB" -ge 24 ]; then PARALLEL=4; elif [ "$MEM_GB" -ge 16 ]; then PARALLEL=2; else PARALLEL=1; fi
fi
case "$PARALLEL" in [1-8]) ;; *) die '--parallel 只能是 1–8' ;; esac
case "$KEEP_ALIVE" in ''|*[!0-9smh-]*) die '--keep-alive 的格式如 15m、1h、0（用完即卸载）或 -1（一直常驻）' ;; esac
if [ "$(uname -m)" != arm64 ]; then warn '不是 Apple 芯片，本地模型只能用 CPU 运行，翻译会很慢'; fi
if [ "$MEM_GB" -lt 16 ]; then warn "内存只有 ${MEM_GB}GB，模型加载后约占 6GB，可能让其他程序变卡"; fi
info "内存 ${MEM_GB}GB：同时处理 ${PARALLEL} 段，空闲 ${KEEP_ALIVE} 后卸载模型"

if ! api /api/version >/dev/null; then
    info '启动 Ollama…'
    open -ga "$APP_PATH"
    wait_for_ollama 60 || die 'Ollama 启动超时，请手动打开 Ollama 后重试'
fi

# ---------- 2. 安装模型 ----------
probe() { curl -s -o /dev/null -L -r 0-8388607 --max-time 12 -w '%{speed_download}' "$@" 2>/dev/null || true; }
choose_source() {
    local official='' mirror_direct mirror_proxy best
    if [ "$MIRROR" != yes ]; then official=$(probe "https://huggingface.co/$GGUF_PATH"); fi
    if [ "$MIRROR" != no ]; then
        mirror_direct=$(probe --noproxy '*' "https://hf-mirror.com/$GGUF_PATH")
        mirror_proxy=$(probe "https://hf-mirror.com/$GGUF_PATH")
    fi
    # 输出「速度 来源 是否绕过代理」，取最快的一项。
    best=$(printf '%s official proxy\n%s mirror direct\n%s mirror proxy\n' "${official:-0}" "${mirror_direct:-0}" "${mirror_proxy:-0}" \
        | awk '{ printf "%.0f %s %s\n", $1, $2, $3 }' | sort -rn | head -1)
    info "下载测速：Hugging Face $(awk -v s="${official:-0}" 'BEGIN{printf "%.1f", s/1048576}')MB/s，镜像直连 $(awk -v s="${mirror_direct:-0}" 'BEGIN{printf "%.1f", s/1048576}')MB/s，镜像走代理 $(awk -v s="${mirror_proxy:-0}" 'BEGIN{printf "%.1f", s/1048576}')MB/s"
    [ "${best%% *}" -gt 0 ] || die '无法连接 Hugging Face 或镜像，请检查网络或代理后重试'
    if [ "$(echo "$best" | awk '{print $2}')" = official ]; then URL="https://huggingface.co/$GGUF_PATH"; else URL="https://hf-mirror.com/$GGUF_PATH"; fi
    if [ "$(echo "$best" | awk '{print $3}')" = direct ]; then CURL_PROXY=(--noproxy '*'); else CURL_PROXY=(); fi
}

install_model() {
    local file have need avail modelfile
    file="$DOWNLOAD_DIR/Hunyuan-MT-7B.Q5_K_M.gguf"
    mkdir -p "$DOWNLOAD_DIR"
    have=$(stat -f %z "$file" 2>/dev/null || echo 0)
    # 剩余下载量 + 导入时 Ollama 再复制一份，下载文件在导入后删除。
    need=$(( (GGUF_SIZE - have + GGUF_SIZE) / 1024 ))
    avail=$(df -k "$DOWNLOAD_DIR" | awk 'NR == 2 { print $4 }')
    [ "$avail" -gt "$need" ] || die "磁盘空间不足，需要约 $(( need / 1048576 + 1 ))GB"
    if [ "$have" -lt "$GGUF_SIZE" ]; then
        choose_source
        info "下载模型（约 5.4GB，可中断后重新运行续传）：$URL"
        curl -L --fail --retry 20 --retry-all-errors --retry-delay 3 -C - -# ${CURL_PROXY[@]+"${CURL_PROXY[@]}"} -o "$file" "$URL"
    fi
    info '校验 SHA-256…'
    if [ "$(shasum -a 256 "$file" | awk '{ print $1 }')" != "$GGUF_SHA256" ]; then
        rm -f "$file"
        die '模型文件校验失败，已删除，请重新运行本脚本'
    fi
    info '导入 Ollama…'
    modelfile=$(mktemp)
    # 模板和停止词与 ollama pull hf.co/… 得到的一致，取自 Hugging Face 为该仓库生成的 Ollama 清单。
    cat > "$modelfile" <<EOF
FROM $file
TEMPLATE """{{ if .System }}<|startoftext|>{{ .System }}<|extra_4|>{{ end }}{{ if .Prompt }}<|startoftext|>{{ .Prompt }}<|extra_0|>{{ end }}{{ .Response }}<|eos|>"""
PARAMETER stop "<|startoftext|>"
PARAMETER stop "<|extra_4|>"
PARAMETER stop "<|extra_0|>"
PARAMETER stop "<|eos|>"
EOF
    "$OLLAMA" create "$MODEL" -f "$modelfile"
    rm -f "$modelfile" "$file"
}

MODELS=$("$OLLAMA" list)
if awk -v model="$MODEL" 'NR > 1 && $1 == model { found = 1 } END { exit !found }' <<<"$MODELS"; then
    info "模型已安装：$MODEL"
else
    install_model
fi

# ---------- 3. 提速设置与开机自启 ----------
info '安装开机自启（LaunchAgent）…'
mkdir -p "$(dirname "$ENV_SCRIPT")" "$(dirname "$PLIST")" "$(dirname "$LOG")"
install -m 755 "$SCRIPT_DIR/ollama-env.sh" "$ENV_SCRIPT"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>$ENV_SCRIPT</string>
        <string>$PARALLEL</string>
        <string>$KEEP_ALIVE</string>
        <string>$APP_PATH</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint -s "$PLIST"
if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then sleep 1; fi
launchctl bootstrap "gui/$(id -u)" "$PLIST"   # 立即运行一次，与登录时的效果相同

info '等待 Ollama 按新设置运行…'
SETTINGS=("OLLAMA_NUM_PARALLEL=$PARALLEL" OLLAMA_FLASH_ATTENTION=1 "OLLAMA_KEEP_ALIVE=$KEEP_ALIVE")
for ((i = 0; i < 90; i++)); do
    if server_env_has "${SETTINGS[@]}" && api /api/version >/dev/null; then break; fi
    sleep 1
done
server_env_has "${SETTINGS[@]}" || die "Ollama 没有按新设置运行，请查看日志：$LOG"

# ---------- 4. 试翻译 ----------
info '试翻译（首次加载模型需要几秒）…'
start=$(date +%s)
result=$(curl -s --noproxy '*' -m 120 "$API/api/chat" -d "{\"model\":\"$MODEL\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"把下面的文本翻译成中文，不要额外解释。\\n\\nLet's touch base next week to review the plan.\"}]}" \
    | sed -n 's/.*"content":"\([^"]*\)".*/\1/p')
[ -n "$result" ] || die '试翻译失败，请确认 Ollama 正常运行后重试'
info "试翻译成功（$(( $(date +%s) - start )) 秒）：$result"

cat <<EOF

全部完成。在浏览器里还需要：
  1. 打开 chrome://extensions/ ，重新加载「DeepL 段落翻译助手」
  2. 点插件图标，「翻译引擎」选「本地模型」，点「测试连接」
撤销提速设置和开机自启：$0 --uninstall
EOF

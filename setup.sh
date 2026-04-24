#!/usr/bin/env bash
set -euo pipefail

echo "🚀 시스템 설정을 시작합니다..."

# 이 스크립트가 있는 디렉터리를 기준 경로로 사용
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/configs"

require_file() {
    local file="$1"
    if [[ ! -e "$file" ]]; then
        echo "❌ 필요한 파일이 없습니다: $file" >&2
        exit 1
    fi
}

link_file() {
    local src="$1"
    local dst="$2"

    require_file "$src"
    mkdir -p "$(dirname "$dst")"
    ln -sfn "$src" "$dst"
    echo "🔗 Linked: $dst -> $src"
}

setup_brew_env() {
    if [[ -x /opt/homebrew/bin/brew ]]; then
        eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -x /usr/local/bin/brew ]]; then
        eval "$(/usr/local/bin/brew shellenv)"
    else
        echo "❌ brew 실행 파일을 찾을 수 없습니다." >&2
        exit 1
    fi
}

# 1. Homebrew 설치
if ! command -v brew >/dev/null 2>&1; then
    echo "📦 Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

setup_brew_env

# 2. 기본 formula 설치
echo "📦 Installing CLI tools..."
brew update
brew install git git-delta fish starship fzf fd eza bat mise

# 3. Git 설정
echo "⚙️ Setting up Git..."
link_file "$CONFIG_DIR/gitconfig" "$HOME/.gitconfig"

# 4. Fish 설정
echo "🐟 Setting up Fish..."
FISH_PATH="$(command -v fish)"

if [[ -z "$FISH_PATH" ]]; then
    echo "❌ fish 실행 파일을 찾을 수 없습니다." >&2
    exit 1
fi

if ! grep -qx "$FISH_PATH" /etc/shells; then
    echo "$FISH_PATH" | sudo tee -a /etc/shells >/dev/null
fi

if [[ "${SHELL:-}" != "$FISH_PATH" ]]; then
    chsh -s "$FISH_PATH"
fi

mkdir -p "$HOME/.config/fish/functions"
link_file "$CONFIG_DIR/config.fish" "$HOME/.config/fish/config.fish"

# 5. Fisher 설치
echo "🎣 Setting up Fisher..."
rm -rf "$HOME/.config/fish/functions/fisher.fish"
curl -fsSL https://raw.githubusercontent.com/jorgebucaran/fisher/main/functions/fisher.fish \
    -o "$HOME/.config/fish/functions/fisher.fish"

fish -c "fisher install jorgebucaran/fisher PatrickF1/fzf.fish"

# 6. Starship 설정
echo "✨ Setting up Starship..."
link_file "$CONFIG_DIR/starship.toml" "$HOME/.config/starship.toml"

# 7. Zed / Mise 설정
echo "🛠️ Setting up Zed and Mise..."
mkdir -p "$HOME/.config/zed" "$HOME/.config/mise"
link_file "$CONFIG_DIR/zed.json" "$HOME/.config/zed/settings.json"
link_file "$CONFIG_DIR/mise.toml" "$HOME/.config/mise/config.toml"

# 8. GUI 앱 설치
echo "🖥️ Installing GUI apps..."
brew install --cask \
    jordanbaird-ice \
    appcleaner \
    raycast \
    rectangle-pro \
    mos \
    zed \
    ghostty \
    libreoffice \
    libreoffice-language-pack \
    font-fira-code-nerd-font

# 9. Ghostty 설정
# Ghostty는 내장 테마를 지원하므로 별도 테마 repo 복제 없이 config만 연결
echo "👻 Setting up Ghostty..."
mkdir -p "$HOME/.config/ghostty"
link_file "$CONFIG_DIR/ghostty.conf" "$HOME/.config/ghostty/config"

# 10. Node.js 설치
echo "🟢 Installing Node.js (LTS) with mise..."
eval "$(mise activate bash)"
mise use --global node@lts

# 11. opencode 설정 설치
echo "🔧 opencode 설정을 설치할까요?"
read -r -p "설치하려면 'y'를 입력하세요. 아니면 종료합니다. [y/N]: " INSTALL_OPENCODE

case "$INSTALL_OPENCODE" in
    [yY]|[yY][eE][sS])
        TARGET_DIR="$SCRIPT_DIR/opencode"

        DEST_ROOT="$HOME/.config/opencode"

        if [ -e "$DEST_ROOT" ] && [ ! -d "$DEST_ROOT" ]; then
            echo "오류: $DEST_ROOT 가 디렉터리가 아닙니다."
            ls -ld "$DEST_ROOT"
            exit 1
        fi

        rm -rf "$DEST_ROOT"
        mkdir -p "$DEST_ROOT"

        cp -a "$TARGET_DIR"/. "$DEST_ROOT"/
        echo "✅ opencode 설정 설치가 완료되었습니다."
        ;;
    *)
        echo "⏹️ opencode 설정 설치를 건너뜁니다."
        exit 0
        ;;
esac

echo "✅ 모든 설정이 완료되었습니다."
echo "ℹ️ 로그인 셸 변경이 반영되지 않았다면 터미널을 다시 시작해 주세요."

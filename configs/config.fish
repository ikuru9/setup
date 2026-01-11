# ---------------------------------------------------------
# Interactive-only guard (스크립트/비인터랙티브에서 불필요한 실행 방지)
# ---------------------------------------------------------
if not status is-interactive
    exit
end

# ---------------------------------------------------------
# Homebrew
# ---------------------------------------------------------
# Apple Silicon 기본 경로
if test -x /opt/homebrew/bin/brew
    /opt/homebrew/bin/brew shellenv | source
# Intel Mac 기본 경로
else if test -x /usr/local/bin/brew
    /usr/local/bin/brew shellenv | source
end

# ---------------------------------------------------------
# PATH (중복 방지: fish_add_path 권장)
# ---------------------------------------------------------
if test -d $HOME/.local/bin
    fish_add_path $HOME/.local/bin
end

# ---------------------------------------------------------
# fnm (Fast Node Manager)
# ---------------------------------------------------------
# - 디렉토리 이동 시 (.nvmrc / .node-version) 자동 적용
# - fish 전용 문법으로 환경 설정 로드
if type -q fnm
    fnm env --use-on-cd --shell fish | source
end

# Starship prompt
if type -q starship
    starship init fish | source
end

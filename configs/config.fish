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

# bun
set --export BUN_INSTALL "$HOME/.bun"
set --export PATH $BUN_INSTALL/bin $PATH

# Starship prompt
if type -q starship
    starship init fish | source
end

# fzf의 기본 외형 설정 (테두리 추가 및 레이아웃 역순)
set -gx FZF_DEFAULT_OPTS "--height 40% --layout=reverse --border --info=inline"

# 만약 bat(문법 강조 도구)이 설치되어 있다면 미리보기 기능 활성화
# brew install bat 명령어로 설치 가능합니다.
set -gx fzf_preview_dir_cmd eza --all --color=always # eza 사용 시
set -gx fzf_fd_opts --hidden --exclude .git

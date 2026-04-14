# ---------------------------------------------------------
# Interactive-only guard
# ---------------------------------------------------------
if not status is-interactive
    exit
end

# ---------------------------------------------------------
# Homebrew
# ---------------------------------------------------------
if test -x /opt/homebrew/bin/brew
    /opt/homebrew/bin/brew shellenv | source
else if test -x /usr/local/bin/brew
    /usr/local/bin/brew shellenv | source
end

# ---------------------------------------------------------
# PATH
# ---------------------------------------------------------
if test -d $HOME/.local/bin
    fish_add_path $HOME/.local/bin
end

# ---------------------------------------------------------
# mise (runtime manager)
# ---------------------------------------------------------
if type -q mise
    mise activate fish | source
    mise completion fish | source
end

# ---------------------------------------------------------
# Starship prompt
# ---------------------------------------------------------
if type -q starship
    starship init fish | source
end

# ---------------------------------------------------------
# fzf (UI / preview)
# ---------------------------------------------------------
set -gx FZF_DEFAULT_OPTS "--height 40% --layout=reverse --border --info=inline"

# eza가 있을 때만 preview 사용
if type -q eza
    set -gx fzf_preview_dir_cmd "eza --all --color=always"
end

set -gx fzf_fd_opts "--hidden --exclude .git"
#!/bin/bash

# Install Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install git and delta
brew install git git-delta
cp -f ./configs/gitconfig ~/.gitconfig
source ~/.gitconfig

# Install fish
brew install fish fisher starship fzf fd eza bat
command -v fish | sudo tee -a /etc/
chsh -s "$(command -v fish)"
# config.fish가 없으면 생성
mkdir -p ~/.config/fish
cp -f ./configs/config.fish ~/.config/fish/config.fish

# fish plugins
starship init fish | source
mkdir -p ~/.config
cp -f ./configs/starship.toml ~/.config/starship.toml
starship explain
fisher install PatrickF1/fzf.fish

# path append
# set -Ux $NAME $VALUE

# Install Utilities
brew install --cask jordanbaird-ice appcleaner raycast rectangle-pro mos

# Install Developer Utilities
brew install fnm
brew install --cask font-fira-code-nerd-font zed visual-studio-code ghostty

# Install Terminal Utility
brew install --cask ghostty
git clone https://github.com/catppuccin/ghostty.git
mkdir -p ~/.config/ghostty/themes
cp ./ghostty/themes ~/.config/ghostty/themes/
cp -f ./config/ghostty.conf ~/.config/ghostty/config

# Copy zed configs
cp -f ./config/zedConfig.json ~/.config/zed/settings.json

# Install Office Utilities
brew install --cask libreoffice libreoffice-language-pack

#!/bin/bash

# Install Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install git and delta
brew install git git-delta
cp ./configs/gitconfig ~/.gitconfig
source ~/.gitconfig

# Install Oh My Zsh
brew install zsh powerlevel10k zsh-autosuggestions zsh-syntax-highlighting
cp ./configs/zshrc ~/.zshrc
cp ./configs/p10k.zsh ~/.p10k.zsh
cp ./configs/zprofile ~/.zprofile
source ~/.zprofile

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
cp ./config/ghostty.conf ~/.config/ghostty/config

# Install Office Utilities
brew install --cask libreoffice libreoffice-language-pack

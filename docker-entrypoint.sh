#!/bin/sh
set -e

# Configure git credentials if GITHUB_TOKEN is provided
if [ -n "$GITHUB_TOKEN" ]; then
  echo "Configuring git credentials..."
  git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
  git config --global user.email "bot@myai.com"
  git config --global user.name "MyAI Bot"
fi

# Clone the target repository if WORKSPACE_REPO is provided
if [ -n "$WORKSPACE_REPO" ] && [ ! -d "/workspace/.git" ]; then
  echo "Cloning workspace repository..."
  # Clean the workspace directory first in case it has files
  rm -rf /workspace/*
  rm -rf /workspace/.[!.]*
  
  # Clone
  git clone "$WORKSPACE_REPO" /workspace
fi

# Execute the main process
exec "$@"

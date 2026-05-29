#!/bin/sh
set -e

# Configure git credentials if GITHUB_TOKEN is provided
if [ -n "$GITHUB_TOKEN" ]; then
  echo "Configuring git credentials..."
  git config --global credential.helper store
  echo "https://${GITHUB_TOKEN}:x-oauth-basic@github.com" > ~/.git-credentials
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

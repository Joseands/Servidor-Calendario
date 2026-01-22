#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/Joseands/Servidor-Calendario.git"
BRANCH="${BRANCH:-main}"

apt-get update -y >/dev/null
apt-get install -y ca-certificates curl git >/dev/null

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP/repo"
bash "$TMP/repo/deploy/install.sh"

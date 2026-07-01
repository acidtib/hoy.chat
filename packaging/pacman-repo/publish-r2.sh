#!/usr/bin/env bash
# Publish a built repo dir to Cloudflare R2 (served at pkgs.hoy.chat). R2 is
# S3-compatible, so this uses the aws CLI with R2's endpoint. `aws s3 sync`
# follows symlinks, so the repo-db symlinks (hoy.db -> hoy.db.tar.gz) upload as
# real objects, which is what pacman fetches.
#
# Required env:
#   R2_ENDPOINT           https://<accountid>.r2.cloudflarestorage.com
#   R2_BUCKET             the bucket name (mapped to pkgs.hoy.chat)
#   AWS_ACCESS_KEY_ID     R2 access key id
#   AWS_SECRET_ACCESS_KEY R2 secret access key
#
# Usage: ./publish-r2.sh --out ./out [--arch x86_64]
set -euo pipefail

out="./out" arch="x86_64" pubkey=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --pubkey) pubkey="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
: "${R2_ENDPOINT:?set R2_ENDPOINT}"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${AWS_ACCESS_KEY_ID:?set AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?set AWS_SECRET_ACCESS_KEY}"
[ -d "$out" ] || { echo "out dir not found: $out" >&2; exit 1; }

dest="s3://${R2_BUCKET}/arch/${arch}/"
echo "Publishing ${out} -> ${dest} (endpoint ${R2_ENDPOINT})"

# sync follows symlinks by default, so hoy.db/.files upload as real objects.
# No --delete: old package versions stay uploadable (downgrades) and a partial
# build can never wipe the repo. The regenerated DB only references current
# packages; prune stale .pkg.tar.zst objects manually if the bucket grows.
aws s3 sync "$out" "$dest" \
  --endpoint-url "$R2_ENDPOINT" \
  --no-progress

# Publish the public key at the bucket root so new users can trust it over HTTPS
# before any signed package exists (bootstraps pacman-key --add / --lsign-key).
if [ -n "$pubkey" ]; then
  [ -f "$pubkey" ] || { echo "pubkey not found: $pubkey" >&2; exit 1; }
  aws s3 cp "$pubkey" "s3://${R2_BUCKET}/hoy-packages.pub" \
    --endpoint-url "$R2_ENDPOINT" --no-progress
  echo "Published key -> https://pkgs.hoy.chat/hoy-packages.pub"
fi

echo "Published. pacman.conf Server: https://pkgs.hoy.chat/arch/\$arch"

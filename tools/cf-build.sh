#!/bin/sh
# Build the folder Cloudflare serves at https://simonsoliloquy.com/train-of-thought/ (see wrangler.jsonc).
# Cloudflare's GitHub build runs this (after npm install) and then `npx wrangler deploy` on every
# push to main. By hand: sh tools/cf-build.sh && npx wrangler@4.40.0 deploy
set -e
cd "$(dirname "$0")/.."
rm -rf .cf
npx vite build --base=/train-of-thought/ --outDir .cf/train-of-thought --emptyOutDir

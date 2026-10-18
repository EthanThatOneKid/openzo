#!/usr/bin/env bash
# Mux the rendered frames with the mixed audio, make a poster, publish to the site.
set -euo pipefail
cd "$(dirname "$0")"
ffmpeg -y -loglevel error -i out/openzo-promo-silent.mp4 -i out/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart out/openzo-promo.mp4
ffmpeg -y -loglevel error -ss 3.6 -i out/openzo-promo.mp4 -frames:v 1 -q:v 3 out/openzo-promo-poster.jpg
mkdir -p ../../openzo-site/public/media
cp out/openzo-promo.mp4 out/openzo-promo-poster.jpg ../../openzo-site/public/media/
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height -of compact out/openzo-promo.mp4

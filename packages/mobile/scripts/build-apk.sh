#!/bin/sh
# Local release APK for sideloading (no Expo account needed): prebuild → gradle assembleRelease.
# Signed with the generated debug keystore, which is fine for personal installs.
#   sh scripts/build-apk.sh [out.apk]     (default ~/Desktop/axo-mobile.apk)
set -e
cd "$(dirname "$0")/.."
OUT="${1:-$HOME/Desktop/axo-mobile.apk}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || true)}"
npm install --no-audit --no-fund --loglevel=error
CI=1 npx expo prebuild -p android --clean --no-install
cd android
./gradlew --no-daemon assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
cp app/build/outputs/apk/release/app-release.apk "$OUT"
ls -lh "$OUT"

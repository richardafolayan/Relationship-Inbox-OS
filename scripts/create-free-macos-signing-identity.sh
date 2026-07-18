#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${RIOS_SIGNING_OUTPUT_DIR:-$ROOT/.release-signing}"
IDENTITY="${RIOS_CODESIGN_IDENTITY:-Tovi Free Update Signing}"

if [[ -z "${RIOS_P12_PASSWORD:-}" ]]; then
  read -r -s -p "Password for the exported private key: " RIOS_P12_PASSWORD
  printf '\n'
fi
if [[ -z "$RIOS_P12_PASSWORD" ]]; then
  echo "A non-empty RIOS_P12_PASSWORD is required." >&2
  exit 1
fi

mkdir -p "$OUT"
umask 077

openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
  -subj "/CN=$IDENTITY" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" \
  -keyout "$OUT/tovi-update-signing.key" \
  -out "$OUT/tovi-update-signing.pem"
openssl x509 -in "$OUT/tovi-update-signing.pem" -outform der \
  -out "$OUT/tovi-update-signing.cer"
openssl pkcs12 -export -legacy \
  -inkey "$OUT/tovi-update-signing.key" \
  -in "$OUT/tovi-update-signing.pem" \
  -name "$IDENTITY" \
  -passout "pass:$RIOS_P12_PASSWORD" \
  -out "$OUT/tovi-update-signing.p12"

if [[ "${RIOS_SKIP_KEYCHAIN_INSTALL:-0}" != "1" ]]; then
  security import "$OUT/tovi-update-signing.p12" \
    -k "$HOME/Library/Keychains/login.keychain-db" \
    -P "$RIOS_P12_PASSWORD" -T /usr/bin/codesign
  security add-trusted-cert -r trustRoot -p codeSign \
    -k "$HOME/Library/Keychains/login.keychain-db" \
    "$OUT/tovi-update-signing.cer"
fi

rm -f "$OUT/tovi-update-signing.key"
chmod 600 "$OUT/tovi-update-signing.p12"
if [[ "${RIOS_SKIP_KEYCHAIN_INSTALL:-0}" == "1" ]]; then
  echo "Created without Keychain installation: $IDENTITY"
else
  echo "Created and installed: $IDENTITY"
fi
echo "Private release files: $OUT"
echo "Keep the password-protected .p12 private. The .cer file is safe to distribute."

#!/usr/bin/env bash
# Publica na VPS uma release do app, sem PR, sem pull e sem rebuild
# (public/ é montado em /app/public pelo docker-compose).
#
# Baixa da release v<versão> do repo do app (público, sem token):
#   agenva-<versão>.apk            o APK
#   agenva-<versão>.version.json   o manifesto do updater, gerado pelo release.yml
#   agenva-<versão>.sha256         checksum dos dois
# Confere o checksum, publica o APK em public/apks/ e SÓ DEPOIS troca o
# public/version.json: o banner nunca aparece antes de o APK estar no ar.
# Nunca sobrescreve um APK que já existe (um já publicado precisa bater com
# o checksum da release). Rodar de novo com uma versão anterior é o rollback.
# Uso (na pasta da API, na VPS): ./scripts/fetch-apk.sh 1.4.1
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "uso: $0 <versão X.Y.Z>" >&2; exit 2; }

REPO="${APK_REPO:-kidev-tec/apk-myschedule}"
BASE="${APK_BASE_URL:-https://github.com/$REPO/releases/download/v$VERSION}"
NAME="agenva-$VERSION.apk"
MANIFEST="agenva-$VERSION.version.json"
SUMS="agenva-$VERSION.sha256"
PUBLIC_DIR="$(cd "$(dirname "$0")/.." && pwd)/public"
DEST_DIR="$PUBLIC_DIR/apks"
DEST="$DEST_DIR/$NAME"

mkdir -p "$DEST_DIR"
# mesmo filesystem de public/: os mv abaixo são renames atômicos
TMP="$(mktemp -d "$DEST_DIR/.fetch-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fetch() { curl -fsSL --retry 3 -o "$TMP/$1" "$BASE/$1"; }
# confere só a linha de um arquivo do .sha256, dentro do diretório dado
check() { (cd "$1" && awk -v n="$2" '$2 == n' "$TMP/$SUMS" | sha256sum -c --strict -); }

fetch "$SUMS"
fetch "$MANIFEST"
check "$TMP" "$MANIFEST"

# o manifesto tem que ser desta versão e apontar para este APK
grep -q "\"version\":\"$VERSION\"" "$TMP/$MANIFEST" \
  && grep -q "\"apk_url\":\"/apks/$NAME\"" "$TMP/$MANIFEST" \
  || { echo "manifesto $MANIFEST não aponta para $VERSION / $NAME" >&2; exit 1; }

if [ -e "$DEST" ]; then
  check "$DEST_DIR" "$NAME" >/dev/null \
    || { echo "$DEST já existe e difere da release — nada publicado" >&2; exit 1; }
  echo "$DEST já publicado (checksum confere)"
else
  fetch "$NAME"
  check "$TMP" "$NAME"
  chmod 644 "$TMP/$NAME"
  # mv -n não sobrescreve se outro processo publicou no meio-tempo.
  mv -n "$TMP/$NAME" "$DEST"
  [ -e "$TMP/$NAME" ] && { echo "$DEST apareceu durante o download — nada publicado" >&2; exit 1; }
  echo "Publicado: $DEST"
fi

chmod 644 "$TMP/$MANIFEST"
mv -f "$TMP/$MANIFEST" "$PUBLIC_DIR/version.json"
echo "version.json → $VERSION (o app já vê o banner)"
echo "Confira: curl -s \"\$API_BASE_URL/v1/version\""

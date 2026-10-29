#!/usr/bin/env bash
# Publica na VPS o APK de uma release do app, sem rebuild do container
# (public/ é montado em /app/public pelo docker-compose).
# Baixa agenva-<versão>.apk + .sha256 da release v<versão> do repo do app
# (público, sem token), confere o checksum e só então move para public/apks/.
# Nunca sobrescreve um APK que já existe.
# Uso (na pasta da API, na VPS): ./scripts/fetch-apk.sh 1.4.1
set -euo pipefail

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "uso: $0 <versão X.Y.Z>" >&2; exit 2; }

REPO="${APK_REPO:-kidev-tec/apk-myschedule}"
NAME="agenva-$VERSION.apk"
BASE="${APK_BASE_URL:-https://github.com/$REPO/releases/download/v$VERSION}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/apks"
DEST="$DEST_DIR/$NAME"

if [ -e "$DEST" ]; then
  echo "$DEST já existe — nada a fazer (APKs publicados nunca são sobrescritos)"
  exit 0
fi

mkdir -p "$DEST_DIR"
TMP="$(mktemp -d "$DEST_DIR/.fetch-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL --retry 3 -o "$TMP/$NAME" "$BASE/$NAME"
curl -fsSL --retry 3 -o "$TMP/$NAME.sha256" "$BASE/$NAME.sha256"
(cd "$TMP" && sha256sum -c "$NAME.sha256")

chmod 644 "$TMP/$NAME"
# mv -n não sobrescreve se outro processo publicou no meio-tempo.
mv -n "$TMP/$NAME" "$DEST"
[ -e "$TMP/$NAME" ] && { echo "$DEST apareceu durante o download — mantido o existente" >&2; exit 1; }
echo "Publicado: $DEST"
echo "Confira: curl -sI \"\$API_BASE_URL/v1/apks/$NAME\" → 200; depois mergear o PR do version.json."

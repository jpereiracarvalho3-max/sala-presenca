#!/bin/sh
# Publica o app: atualiza o número da versão (para os navegadores recarregarem sozinhos) e envia ao GitHub.
# Uso: ./publicar.sh "descrição da mudança"
set -e
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M%S)
sed -i '' "s/^const VER='[0-9]*';/const VER='$V';/" index.html
echo "$V" > version.txt
git add -A
git commit -q -m "${1:-Atualiza o app}"
git push -q origin main
echo "Publicado: versão $V"

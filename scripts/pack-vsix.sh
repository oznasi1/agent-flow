#!/usr/bin/env bash
# Build a .vsix without vsce/npm (a .vsix is just a structured zip).
# Usage: npm run build -- --production && bash scripts/pack-vsix.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
PUBLISHER=$(node -p "require('./package.json').publisher")
DISPLAY=$(node -p "require('./package.json').displayName || require('./package.json').name")
ENGINE=$(node -p "require('./package.json').engines.vscode")
VSIX="$ROOT/${NAME}-${VERSION}.vsix"

STAGE=$(mktemp -d)
mkdir -p "$STAGE/extension/dist" "$STAGE/extension/media"
cp package.json README.md "$STAGE/extension/"
cp dist/extension.js dist/webview.js "$STAGE/extension/dist/"
cp media/*.svg "$STAGE/extension/media/" 2>/dev/null || true

cat > "$STAGE/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/>
<Default Extension="js" ContentType="application/javascript"/>
<Default Extension="svg" ContentType="image/svg+xml"/>
<Default Extension="md" ContentType="text/markdown"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/>
</Types>
XML

cat > "$STAGE/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${NAME}" Version="${VERSION}" Publisher="${PUBLISHER}"/>
    <DisplayName>${DISPLAY}</DisplayName>
    <Description xml:space="preserve">Grab a Jira task and spin up its workspace.</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${ENGINE}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace"/>
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
  </Assets>
</PackageManifest>
XML

( cd "$STAGE" && rm -f "$VSIX" && zip -r -X "$VSIX" "[Content_Types].xml" extension.vsixmanifest extension >/dev/null )
rm -rf "$STAGE"
echo "packaged: $VSIX"

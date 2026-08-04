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
# Read from package.json rather than hardcoding — a literal here goes stale silently.
XMLESC='const s=String(x);process.stdout.write(s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"))'
DESCRIPTION=$(node -e "const x=require('./package.json').description||'';$XMLESC")
CATEGORIES=$(node -e "const x=(require('./package.json').categories||['Other']).join(',');$XMLESC")
TAGS=$(node -e "const x=(require('./package.json').keywords||[]).join(',');$XMLESC")
VSIX="$ROOT/${NAME}-${VERSION}.vsix"

STAGE=$(mktemp -d)
mkdir -p "$STAGE/extension/dist" "$STAGE/extension/media"
cp package.json README.md CHANGELOG.md LICENSE "$STAGE/extension/"
# Glob the bundles: enumerating them by hand has twice shipped a vsix missing one.
# `*.js` skips the `.js.map` sourcemaps and the `.cjs` test helper on its own.
cp dist/*.js "$STAGE/extension/dist/"
cp media/*.svg media/*.png "$STAGE/extension/media/" 2>/dev/null || true

cat > "$STAGE/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="json" ContentType="application/json"/>
<Default Extension="js" ContentType="application/javascript"/>
<Default Extension="svg" ContentType="image/svg+xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="md" ContentType="text/markdown"/>
<Default Extension="vsixmanifest" ContentType="text/xml"/>
<Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>
XML

cat > "$STAGE/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${NAME}" Version="${VERSION}" Publisher="${PUBLISHER}"/>
    <DisplayName>${DISPLAY}</DisplayName>
    <Description xml:space="preserve">${DESCRIPTION}</Description>
    <Tags>${TAGS}</Tags>
    <Categories>${CATEGORIES}</Categories>
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
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon-store.png" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true"/>
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true"/>
  </Assets>
</PackageManifest>
XML

( cd "$STAGE" && rm -f "$VSIX" && zip -r -X "$VSIX" "[Content_Types].xml" extension.vsixmanifest extension >/dev/null )
rm -rf "$STAGE"
echo "packaged: $VSIX"

#!/bin/sh
# Finishes a packaged Linux folder (dist/OscarDJ-linux-<arch>): adds the launcher script, the icon
# and install-desktop-entry.sh. Used by `npm run package:linux-x64` and the release workflow.
# Usage: scripts/linux-bundle.sh <packaged folder>
set -e
dir="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$dir/oscardj" ] || { echo "No packaged app in $dir" >&2; exit 1; }
cp "$root/assets/icon.png" "$dir/oscardj.png"

# Chromium's sandbox needs either unprivileged user namespaces (most distributions) or its
# setuid helper owned by root, which an unpacked tarball can't keep. Only when neither is there
# does the app start without the sandbox.
cat > "$dir/OscarDJ.sh" <<'LAUNCHER'
#!/bin/sh
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
sandbox=no
if [ "$(stat -c %u "$here/chrome-sandbox" 2>/dev/null)" = 0 ] && [ -u "$here/chrome-sandbox" ]; then sandbox=yes
elif [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 1 ] \
  && [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 0)" -gt 0 ] \
  && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 0 ]; then sandbox=yes
fi
if [ "$sandbox" = yes ]; then exec "$here/oscardj" "$@"; fi
exec "$here/oscardj" --no-sandbox "$@"
LAUNCHER

cat > "$dir/install-desktop-entry.sh" <<'INSTALLER'
#!/bin/sh
# Adds OscarDJ to your app menu and launcher (current user only). Run it again if you move this folder.
here="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$apps"
cat > "$apps/oscardj.desktop" <<ENTRY
[Desktop Entry]
Type=Application
Name=OscarDJ
GenericName=DJ Software
Comment=Mix your own music on two or four decks
Keywords=OpenDJ;DJ;mix;music;decks;turntable;
Exec="$here/OscarDJ.sh" %F
Icon=$here/oscardj.png
Categories=AudioVideo;Audio;Player;
StartupWMClass=oscardj
Terminal=false
ENTRY
if command -v update-desktop-database > /dev/null 2>&1; then update-desktop-database "$apps" > /dev/null 2>&1 || true; fi
echo "Added OscarDJ to your app menu."
INSTALLER

chmod +x "$dir/OscarDJ.sh" "$dir/install-desktop-entry.sh" "$dir/oscardj" "$dir/resources/bin/"*

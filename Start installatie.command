#!/bin/zsh
# ── OLTC — Start installatie + admin ─────────────────────────────────────────
cd "$(dirname "$0")/server"

# Kill any previous instance on port 3000
lsof -ti :3000 | xargs kill -9 2>/dev/null

# Start the server in the background
node server.js &
SERVER_PID=$!

# Wait for the server to be ready
echo "Server starten…"
for i in $(seq 1 20); do
  sleep 0.5
  curl -s http://localhost:3000 > /dev/null 2>&1 && break
done

# Open admin panel first, in the regular Chrome instance
open -a "Google Chrome" http://localhost:3000/admin.html

# Give regular Chrome a moment to claim the app before kiosk Chrome launches
sleep 1

# Open user view in kiosk mode on second screen (x=-1280, y=0 = left monitor, 1280x720)
# Separate --user-data-dir keeps this instance isolated from regular Chrome
# Wipe the kiosk cache so code changes are always picked up fresh
pkill -f "oltc-kiosk" 2>/dev/null || true
rm -rf /tmp/oltc-kiosk
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir=/tmp/oltc-kiosk \
  --kiosk \
  --window-position=-1280,0 \
  --no-first-run \
  http://localhost:3000 &

echo "Installatie actief op http://localhost:3000"
echo "Admin actief op http://localhost:3000/admin.html"
echo "Druk op Ctrl+C om te stoppen."
wait $SERVER_PID

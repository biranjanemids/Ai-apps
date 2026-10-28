#!/data/data/com.termux/files/usr/bin/bash
# One-time install of the LinkedIn Job Agent on an Android phone (Termux).
#   curl -fsSL https://raw.githubusercontent.com/biranjanemids/Ai-apps/claude/linkedin-bangalore-job-agent-x13ndj/linkedin-job-agent/termux/setup.sh | bash
set -e
BRANCH="${BRANCH:-claude/linkedin-bangalore-job-agent-x13ndj}"
REPO="${REPO:-https://github.com/biranjanemids/Ai-apps.git}"
DIR="$HOME/Ai-apps"

echo "==> Installing Node.js, git and Chromium (takes a few minutes)…"
pkg update -y
pkg install -y nodejs-lts git curl x11-repo
pkg install -y chromium
pkg install -y termux-api || true   # optional: phone notifications (also install the Termux:API app)

echo "==> Downloading the agent…"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR/linkedin-job-agent"

echo "==> Installing dependencies and building…"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund
npm run build
mkdir -p data

if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  sed -i "s/^DASHBOARD_TOKEN=.*/DASHBOARD_TOKEN=$TOKEN/" .env
  sed -i "s|^RESUME_PATH=.*|RESUME_PATH=|" .env
  sed -i "s/^MAX_JOBS_SCANNED_PER_KEYWORD=.*/MAX_JOBS_SCANNED_PER_KEYWORD=30/" .env
fi

# Home-screen buttons (needs the Termux:Widget app)
mkdir -p "$HOME/.shortcuts"
cp termux/start.sh "$HOME/.shortcuts/Job Agent"
cp termux/stop.sh "$HOME/.shortcuts/Stop Job Agent"
cp termux/check.sh "$HOME/.shortcuts/Check Job Agent"
cp termux/report.sh "$HOME/.shortcuts/Job Agent Report"
chmod +x "$HOME/.shortcuts/"*

# Start automatically when the phone boots (needs the Termux:Boot app, opened once)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/job-agent" <<'BOOT'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
bash "$HOME/Ai-apps/linkedin-job-agent/termux/start.sh" --no-open
BOOT
chmod +x "$HOME/.termux/boot/job-agent"

# A dashboard left running from before would keep using the old code
if pgrep -f "dist/cli.js serve" > /dev/null; then
  echo "==> Restarting the agent with the new version…"
  bash termux/start.sh --no-open
fi

echo
echo "✔ Installed. Start it with:   bash ~/Ai-apps/linkedin-job-agent/termux/start.sh"
echo "  (or add the Termux:Widget 'Job Agent' button to your home screen)"

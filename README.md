# 🎭 Playwright Trainer

An interactive browser-automation training tool that runs fully inside **GitHub Codespaces**.

Record your browser interactions once, save them as reusable Playwright scripts, then replay them — even in loops — with different parameters.

---

## Features

| Feature | Description |
|---|---|
| 📹 **Visual Recording** | Headed Chromium browser (via Xvfb + noVNC) — you interact, the trainer captures every click, fill, select, check, and download |
| 🧠 **Smart capture** | Debounced fills, deduplication of navigations, sensitive-field detection, multi-tab tracking |
| 💾 **Named sessions** | Stop recording → popup appears → name your script → saved to `scripts/` as a standalone `.js` file |
| 🔁 **Loop support** | Each saved script accepts a params object; pass an array of param sets to iterate over date ranges, accounts, etc. |
| ▶ **Replay panel** | Select a script, provide JSON params (or a loop array), and run it right from the UI |
| 🔍 **Script viewer** | Inspect the generated Playwright source code inline |
| 🖥️ **noVNC browser view** | See the live browser at `http://localhost:6080` while recording |

---

## Quick Start — GitHub Codespaces

1. Open this repository in GitHub Codespaces  
   *(Repository → Code → Codespaces → Create codespace)*

2. The devcontainer automatically:
   - Installs Node.js dependencies (`npm install`)
   - Downloads Playwright Chromium (`npx playwright install chromium`)
   - Starts **Xvfb** virtual display on `:99`
   - Starts **x11vnc** + **noVNC** WebSocket proxy on port `6080`
   - Starts the Trainer server on port `3000`

3. Codespaces will open two forwarded ports:
   - **3000** → Trainer Control Panel (opens automatically)
   - **6080** → Browser View at `/vnc.html`

---

## How to Record a Procedure

1. In the **Control Panel** (port 3000), enter a **Start URL** (e.g., `https://myapp.gr/login`)
2. Click **▶ Start Recording**
3. In the **Browser View** (port 6080), interact normally:
   - Log in, fill forms, navigate, click links, download files
4. When done, click **⏹ Stop & Save** in the Control Panel
5. A **Save Recording** popup appears:
   - Give the script a name (e.g., `login_download_vat`)
   - Optionally define **parameters** — values that vary between runs (dates, usernames, etc.)
   - Click **💾 Save Script**

The script is saved to `scripts/<name>.js` in the project root.

---

## How to Run a Script

### Single run
```bash
node scripts/login_download_vat.js
```

### Single run with params
```bash
node scripts/login_download_vat.js
# or via the UI: set Params JSON and click ▶ Run
```

### Loop run (from UI)
Fill **Loop Params** with a JSON array:
```json
[
  { "startDate": "2024-01", "endDate": "2024-03" },
  { "startDate": "2024-04", "endDate": "2024-06" }
]
```
Click **▶ Run** — the script executes once per element.

### Loop run (CLI)
```bash
node scripts/login_download_vat.js --loop '[{"startDate":"2024-01"},{"startDate":"2024-02"}]'
```

---

## Project Structure

```
playwright-trainer/
├── server.js                  # Express + Socket.io + Playwright orchestration
├── package.json
├── public/
│   ├── index.html             # Trainer Control Panel UI
│   ├── style.css
│   └── app.js                 # Client-side Socket.io logic
├── recorder/
│   └── actions-to-script.js   # Converts captured actions → Playwright script
├── scripts/                   # 💾 Your saved recording scripts live here
├── downloads/                 # Files downloaded during recording/replay
└── .devcontainer/
    ├── devcontainer.json       # Codespaces configuration
    └── startup.sh              # Xvfb + noVNC + server startup
```

---

## Running Locally (without Codespaces)

```bash
npm install
npx playwright install chromium

# Headed mode (macOS/Windows — display available automatically):
node server.js

# Headless mode (Linux CI, no display):
node server.js         # auto-detects missing DISPLAY → uses headless

# Headed mode on Linux (manual Xvfb):
Xvfb :99 -screen 0 1280x900x24 &
DISPLAY=:99 node server.js
```

Open `http://localhost:3000` in your browser.

---

## Generated Script Format

Every saved script is a self-contained Node.js module:

```javascript
async function run(params = {}) {
  const { startDate = '2024-01-01', email = 'user@example.com' } = params;
  const browser = await chromium.launch({ headless: true });
  // ... recorded steps using params ...
}

async function runLoop(paramsArray = []) {
  for (const p of paramsArray) { await run(p); }
}

module.exports = { run, runLoop };
```

Scripts can be imported into any other Node.js project or run directly from the CLI.

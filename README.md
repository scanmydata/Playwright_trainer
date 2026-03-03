# 🎭 Playwright Trainer

An interactive browser-automation training tool that runs fully inside **GitHub Codespaces**.

Record your browser interactions once, save them as reusable Playwright scripts, then replay them — even in loops — with different parameters.

---

## Features

| Feature | Description |
|---|---|
| 📹 **Visual Recording** | Headed Chromium browser (via Xvfb + noVNC) — you interact, the trainer captures every click, fill, select, check, and download |
| 🧠 **Smart capture** | Debounced fills, deduplication of navigations, sensitive-field detection, multi-tab tracking |
| 💾 **Named sessions** | Stop recording → popup appears → name your script → saved to `user-scripts/` as a standalone `.js` file |
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

1. In the **Control Panel** (port 3000), enter a **Start URL** (e.g., `https://myapp.gr/login`) or choose a **Service preset**
2. Click **▶ Start Recording**
3. In the **Browser View** (port 6080), interact normally:
   - Log in, fill forms, navigate, click links, download files
4. When done, click **⏹ Stop & Save** in the Control Panel
5. A **Save Recording** popup appears:
   - Give the script a name (e.g., `login_download_vat`)
   - Optionally define **parameters** — values that vary between runs (dates, usernames, etc.)
   - Click **💾 Save Script**

The script is saved to `user-scripts/<name>.js` in the project root.

### Direct e-service start (AADE / similar SSO portals)

- Prefer starting from the **final service URL** (resource endpoint), not from a copied long `login.jsp?...` URL.
- Portals usually redirect unauthenticated users to login and then back to the requested resource.
- Long login URLs often contain volatile values (`request_id`, `bmctx`, etc.) that expire and break replay.
- In the UI you can now pick a **Service preset** to auto-fill known direct service URLs.

---

## How to Run a Script

### Single run
```bash
node user-scripts/login_download_vat.js
```

### Single run with params
```bash
# supply JSON via new --params flag (you can now also specify periodType/month/quarter or a date range):
node user-scripts/login_download_vat.js --params '{"username":"alice","password":"secret","year":2025,"periodType":"oneMonth","month":7}'
# or via the UI: set Params JSON and click ▶ Run

For headless debugging you can prefix with `PW_HEADLESS=0` (or `PW_HEADLESS=1` to force headless). Examples:

```bash
# single month
PW_HEADLESS=0 node user-scripts/CC.js --params '{"username":"foo","password":"bar","year":2025,"periodType":"oneMonth","month":7}'

# single quarter
PW_HEADLESS=0 node user-scripts/CC.js --params '{"username":"foo","password":"bar","year":2025,"periodType":"threeMonths","quarter":2}'

# whole year 2025 (bulk quarters)
PW_HEADLESS=0 node user-scripts/CC.js --params '{"username":"foo","password":"bar","year":2025,"periodType":"threeMonths"}'

# note: each period's PDF is saved with its period label (e.g. viewPdf-1, viewPdf-2)

# arbitrary date range (monthly)
PW_HEADLESS=0 node user-scripts/CC.js --params '{"username":"foo","password":"bar","startDate":"2025-01","endDate":"2025-12"}'
```
> Recorded scripts that navigate to a declarations list now automatically try to
> download the PDF. The runner will also clear cookies, permissions and hit the
> GSIS logout endpoint before attempting login, ensuring you can supply fresh
> credentials each run.  If the page indicates there are no obligations for the
> selected period the script will log a message and return `{ noOblig: true }`.
>
> In fact the script now builds a small result object and prints it at the end
> of every run so you can see what happened:
> * `noOblig`: true if the page contained either the “no obligations” or “no
>   saved declarations” message
> * `invalidCreds`: true when login fails and an error message is shown on the
>   credentials page
> * `downloaded`: true if a PDF was successfully fetched
> * `downloadPath`: path where the file was written, if any
> * `error`: string describing any error (including skipped login)
>
> **Bulk period support:** omit `month` when `periodType` is `oneMonth` or omit
> `quarter` when `periodType` is `threeMonths` and the runner will automatically
> iterate through all 12 months or four quarters of the year in a single
> browser session. Results are returned as an array of objects, one per period.
>
> First the script tries to click any visible download
> button in the popup (eg. the toolbar Λήψη/Download icon) and catch the
> resulting `download` event. If no such button is present it inspects the
> page for an embedded PDF URL and fetches that resource with the browser
> context (keeping cookies); only as a last resort does it fall back to a
> generic download event. The file is written to `downloads/viewPdf.pdf`
> (timestamp appended when running multiple times).  This approach avoids
> corrupted HTML placeholder files when the PDF viewer is rendered inline.
```

### Loop run (from UI)
When you select a saved script from the sidebar the **Params** field will be automatically populated with any
variables the script defines (or, if none were explicitly defined, inferred from the recorded steps).
You can edit the values directly before running, or use the templated object as a starting point.

Fill **Loop Params** with a JSON array — the UI also prepares a sample array for you automatically:
```json
[
  { "startDate": "2024-01", "endDate": "2024-03" },
  { "startDate": "2024-04", "endDate": "2024-06" }
]
```
Click **▶ Run** — the script executes once per element.

### Loop run (CLI)
```bash
node user-scripts/login_download_vat.js --loop '[{"startDate":"2024-01"},{"startDate":"2024-02"}]'
```

---

## Project Structure

> **Note:** older versions stored scripts under `scripts/`. On startup the server will automatically
> relocate any `.js` files to the new `user-scripts/` directory so your recordings are preserved.


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
├── user-scripts/              # 💾 User-generated scripts (saved here & shown in dropdown)
├── system-scripts/            # 🔒 Internal/example scripts (not shown in delete UI)
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

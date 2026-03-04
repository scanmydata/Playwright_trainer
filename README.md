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

For headless debugging you can prefix with `PW_HEADLESS=0` (or `PW_HEADLESS=1` to force headless). You can also enable verbose debug logging by exporting `DEBUG=1` before running the script; the runner will print extra diagnostic information such as dropdown values, discovered button lists, popup events, etc. Examples:

```bash
# headed mode with debug output
PW_HEADLESS=0 DEBUG=1 node user-scripts/CC.js --params '{"username":"foo","password":"bar","year":2025,"periodType":"oneMonth","month":7}'

# single quarter
PW_HEADLESS=0 DEBUG=1 node user-scripts/CC.js --params '{"username":"foo","password":"bar","year":2025,"periodType":"threeMonths","quarter":2}'

# whole year 2025 (bulk quarters)
PW_HEADLESS=0 DEBUG=1 node user-scripts/CC.js --params '{"username":"foo","password":"bar","year":2025,"periodType":"threeMonths"}'

# note: each period's PDF is saved with its period label (e.g. viewPdf-1, viewPdf-2)

# arbitrary date range (monthly)
PW_HEADLESS=0 DEBUG=1 node user-scripts/CC.js --params '{"username":"foo","password":"bar","startDate":"2025-01","endDate":"2025-12"}'
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

## Example: E1/E2/E3 Income Tax Declarations Script

The `user-scripts/e1-e2-e3.js` script downloads E1/E2/E3 income tax declarations and εκκαθαριστικά from the AADE portal.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `username` | string | `""` | TAXISnet username (required) |
| `password` | string | `""` | TAXISnet password (required) |
| `years` | number or array | `[2025]` | Year(s) to download. Single year: `2025`, multiple: `[2023,2024,2025]` |
| `docs` | string[] | auto-discovered | Document button names to download. Use shortcuts: `"E1"`, `"E2_YPO"`, `"E2_SYZ"`, `"E3"`, `"EKKATH"`, `"EKKATH_SYZ"` or full button names like `"PBE1_PRINT_PDF"`, `"PB_EKKATH_PDF"` |
| `choices` | object | `{}` | Optional: pre-select dropdown values, e.g. `{"YEAR":"2025"}` |

### Return Object (result)

The script returns an object with the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `noOblig` | boolean | `true` if no data/obligations were found for the requested period |
| `downloaded` | boolean | `true` if at least one PDF was successfully saved |
| `downloadPath` | string\|null | Path to the last downloaded file, or `null` if none |
| `invalidCreds` | boolean | `true` when login fails with an error message |
| `error` | string\|null | Error message string if an error occurred, otherwise `null` |

### Environment Variables

- **`PW_HEADLESS=0`** : Run in headed mode (visible browser window) — useful for debugging
- **`PW_HEADLESS=1`** : Run in headless mode (default)
- **`DEBUG=1`** : Enable verbose debug output (prints dropdown lists, discovered buttons, popup events, etc.)

### Usage Examples

#### Basic: Download E1 and EKKATH for 2025 (default year)
```bash
node user-scripts/e1-e2-e3.js \
  --params '{"username":"user4536951550","password":"antonis38"}'
```

#### Specific year with selected documents
```bash
node user-scripts/e1-e2-e3.js \
  --params '{"username":"user4536951550","password":"antonis38",\
"years":2025,"docs":["E1","EKKATH"]}'
```

#### Headed mode with debug output
```bash
PW_HEADLESS=0 DEBUG=1 node user-scripts/e1-e2-e3.js \
  --params '{"username":"youruser","password":"yourpass","years":2025}'
```

#### Multiple years
```bash
node user-scripts/e1-e2-e3.js \
  --params '{"username":"youruser","password":"yourpass",\
"years":[2023,2024,2025],"docs":["E1","EKKATH"]}'
```

#### Specify dropdown selections explicitly
```bash
node user-scripts/e1-e2-e3.js \
  --params '{"username":"youruser","password":"yourpass",\
"years":2025,"docs":["E1","EKKATH"],"choices":{"YEAR":"2025"}}'
```

#### Loop over multiple credential sets
```bash
node user-scripts/e1-e2-e3.js \
  --loop '[{"username":"user1","password":"pass1"},\
{"username":"user2","password":"pass2"}]'
```

### How It Works

1. **Auto-discovery**: If you don't specify `docs`, the script scans the page for enabled document buttons and automatically filters out:
   - ΣΥΝΟΨΗ (summary)
   - myDATA buttons
   - Τροποποιητική (amendment) buttons

2. **Smart download**: When clicking a document button opens a popup/new tab with a PDF viewer, the script:
   - Detects the popup
   - Tries multiple download methods in order:
     - Click `#icon` or `cr-icon` (Chrome PDF viewer download button)
     - Click shadow-DOM icon elements
     - Use standard download links/buttons
     - Capture PDF from network response
     - Fetch PDF URL directly from embed/iframe/object elements

3. **Disabled button handling**: Automatically skips disabled document buttons to prevent timeouts.

4. **File naming**: Downloads are saved to `downloads/report-<DOC>-<YEAR>.pdf`

### Debug Output Example

When running with `DEBUG=1`, the script prints:

```
[run] dropdowns on page (year 2025): [
  { name: 'YEAR', options: [ { value: '2025', text: '2025' }, ... ] }
]
[run] discovered document buttons [
  { name: 'PBE1_PRINT_PDF', text: 'Ε1', disabled: false },
  { name: 'PB_EKKATH_PDF', text: 'ΕΚΚΑΘΑΡΙΣΤΙΚΟ ΥΠΟΧΡΕΟΥ', disabled: false },
  { name: 'PBE2_PRINT_PDF', text: 'Ε2 ΥΠΟΧΡΕΟΥ', disabled: true }
]
[run] default docs list -> [ 'PBE1_PRINT_PDF', 'PB_EKKATH_PDF' ]
[run] downloading E1 for year 2025
[download] saved to /workspaces/Playwright_trainer/downloads/report-E1-2025.pdf
```

### Notes

- The script defaults to **year 2025** when no year is specified
- Files are saved to the `downloads/` folder with descriptive names
- The script handles login, navigation, popup windows, and logout automatically
- Use document shortcuts (`E1`, `EKKATH`) or full button names (`PBE1_PRINT_PDF`) interchangeably

> In our environment real network access may be restricted; the
> examples above assume the portal is reachable and the selectors still
> match the corresponding buttons.  The script logs available dropdowns and
> button names to help you pick the right `docs` values when running against
> a live session.

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

## Example: E9/ENFIA script
...
The `user-scripts/e9-enfia.js` script automates downloading the
Ε9/ENFIA property declaration and periodic statements from the
AADE‑ETAK portal.  It accepts credentials plus optional year(s) and
document types.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `username` | string | `""` | TAXISnet username (required) |
| `password` | string | `""` | TAXISnet password (required) |
| `years` | number or number[] | `[current year]` | Year or list of years to query |
| `docs` | string[] | `['property']` | Which documents to fetch: `'property'` (περιουσιακή κατάσταση) and/or `'enfia'` |

### Result Object

Returns an object (or array when multiple year/doc combinations are
requested) containing the standard flags:

- `noOblig` – true if no file was available for the request
- `downloaded` – true if a PDF was saved
- `downloadPath` – path of the saved file when applicable
- `invalidCreds` – true when login fails
- `error` – error message on failure

### Examples

Download property statement for 2025 (default year):
```bash
node user-scripts/e9-enfia.js \
  --params '{"username":"foo","password":"bar"}'
```

Fetch both property and ENFIA for 2023 and 2024:
```bash
node user-scripts/e9-enfia.js \
  --params '{"username":"foo","password":"bar","years":[2023,2024],"docs":["property","enfia"]}'
```

Run in headed/debug mode:
```bash
PW_HEADLESS=0 DEBUG=1 node user-scripts/e9-enfia.js \
  --params '{"username":"foo","password":"bar","years":2026}'
```

Loop over multiple credentials:
```bash
node user-scripts/e9-enfia.js --loop '[{"username":"a","password":"x"},{"username":"b","password":"y"}]'
```

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

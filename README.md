# F1 Dashboard — Overtake Zone Highlighter & 4-Factor Probability Scorer (`<1.0s`)

A lightweight, zero-dependency browser extension for [`app.formula1dashboard.com/live-timing/`](https://app.formula1dashboard.com/live-timing/) that detects when two consecutive drivers on the leaderboard are within **1.0 second** of each other, highlights both rows, and computes a real-time **Overtake Probability Score (`15% – 99%`)** based on live telemetry.

---

## What It Does

1. **Real-Time `< 1.0s` Battle Detection**
   * Continuously monitors the live-timing leaderboard using a `MutationObserver` synchronized with `requestAnimationFrame`.
   * Automatically skips drivers currently in the `PIT`, `OUT`, or retired (`RET`/`DNF`).
   * Highlights **both** the defending driver ahead and the chasing driver behind whenever the interval drops below `1.000s`.

2. **4-Factor Overtake Probability Score (`15% – 99%`)**
   Instead of treating all `< 1.0s` gaps equally, the extension extracts a live telemetry snapshot from each driver's row and scores the likelihood of an overtake across four factors:
   * **Factor 1 — Proximity / Interval Gap (24 to 50 pts):** Smooth scoring curve based on how close the chasing car is (`+0.200s` scores up to 48 pts; `+0.990s` scores 24 pts).
   * **Factor 2 — Pace Delta & Closing Trend (-10 to +24 pts):** Tracks interval history across updates to see if the gap is actively shrinking, and compares **Last Lap** and **Sector (`S1`/`S2`/`S3`)** times between the two cars.
   * **Factor 3 — Mini-Sector Momentum (0 to +14 pts):** Inspects CSS classes and RGB colors of mini-sector and sector blocks to award momentum points when the chaser has more **Purple** (session fastest) and **Green** (personal best) segments than the car ahead.
   * **Factor 4 — Tire Compound & Tire Age Advantage (-6 to +14 pts):** Compares tire compound softness (`Soft > Medium > Hard > Inter > Wet`) and tire age delta in laps (e.g., fresh tires vs. worn tires).

3. **3-Tier F1 Color Coding & Breakdown Tooltip**
   * **🔥 High Threat (`>= 70%`) — F1 Purple:** Imminent overtake threat.
   * **⚡ Active Battle (`45% – 69%`) — Green:** Solid DRS/slipstream battle.
   * **👀 Watch / Closing (`< 45%`) — Yellow / Amber:** Within 1.0s, but pace/tires currently favor the defending car.
   * **Hover Tooltip:** Hover your mouse over any inline `%` badge next to the interval column to view the exact point breakdown for that battle.
   * **Toggle Pill:** Click the floating **`Overtake <1.0s`** pill in the bottom-right corner of the page at any time to toggle the highlights on or off.

---

## Project Structure & Where to Place Files

Keep all three extension files together inside the same directory (e.g., `/home/c/projects/f1dash_extension/`):

```text
f1dash_extension/
├── manifest.json   # Manifest V3 config (permissions, target URLs, Firefox gecko ID)
├── content.js      # Telemetry parser, 4-factor scoring engine, and DOM observer
├── styles.css      # Purple/Green/Amber row highlights, score badges, and status pill
└── README.md       # Project documentation
```

> **Note:** You can move or copy the `f1dash_extension` folder anywhere on your computer, as long as `manifest.json`, `content.js`, and `styles.css` remain inside the same folder.

---

## How to Load the Extension

### Option 1: Firefox (Temporary Add-on)

1. Open Firefox, type the following into the address bar, and press **Enter**:
   ```text
   about:debugging#/runtime/this-firefox
   ```
2. Click the **Load Temporary Add-on...** button near the top right.
3. Navigate to your `/home/c/projects/f1dash_extension` folder and select **`manifest.json`**.
4. Open [`https://app.formula1dashboard.com/live-timing/`](https://app.formula1dashboard.com/live-timing/) (or refresh the tab if it is already open).
5. **Reloading after code edits:** If you modify `content.js` or `styles.css`, click **Reload** next to the extension on the `about:debugging` tab and refresh the F1 dashboard tab.

*(Note: Firefox temporary add-ons remain active until you quit Firefox. Simply re-load `manifest.json` via `about:debugging` the next time you start Firefox for a race session).*

### Option 2: Chrome / Brave / Edge / Vivaldi (Unpacked Extension)

1. Open your Chromium-based browser and go to:
   ```text
   chrome://extensions
   ```
   *(or `brave://extensions` / `edge://extensions`)*
2. Turn **ON** the **Developer mode** toggle switch in the top-right corner.
3. Click **Load unpacked** in the top-left corner.
4. Select the `/home/c/projects/f1dash_extension` folder.
5. Open [`https://app.formula1dashboard.com/live-timing/`](https://app.formula1dashboard.com/live-timing/).

---

## How to Use It During a Session

1. Navigate to [`https://app.formula1dashboard.com/live-timing/`](https://app.formula1dashboard.com/live-timing/) during a live session or replay.
2. Check the bottom-right corner of the screen for the **`Overtake <1.0s: X battles (Peak Y%)`** status pill to confirm the extension is active.
3. Watch the leaderboard:
   * Whenever a driver drops under `+1.000s` behind the car ahead, both driver rows highlight in **Purple** (`>= 70%`), **Green** (`45%–69%`), or **Amber** (`< 45%`).
   * Hover over the **`🔥 76%`** / **`⚡ 58%`** badge next to the interval time to see *why* the score is high or low (gap points, closing rate, sector deltas, mini-sectors, and tire delta).
   * Click the bottom-right **`Overtake <1.0s`** pill anytime to temporarily disable or re-enable highlighting.

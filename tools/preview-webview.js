#!/usr/bin/env node
"use strict";

/**
 * LOCAL DEV-ONLY preview harness for the Kiro Stat sidebar webview.
 *
 * What it does
 * ------------
 * 1. Stubs the `vscode` module so the compiled extension can be required outside
 *    of an extension host.
 * 2. Requires `out/extension.js` and calls the pure `getProfileHtml(...)` export
 *    with a rich set of SYNTHETIC (never real) profile data.
 * 3. Injects a small `acquireVsCodeApi()` shim (using the page's own nonce) so the
 *    generated webview script runs unmodified in a normal browser, and writes the
 *    result to `preview/webview-preview.html`.
 *
 * Safety / constraints
 * --------------------
 * - No network access, no reading of real user data, no runtime or dev dependencies.
 * - Does NOT touch `src/extension.ts`; purely additive dev tooling.
 * - The generated HTML is NOT modified except for injecting the shim script tag.
 */

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const repoRoot = path.resolve(__dirname, "..");
const extensionEntry = path.join(repoRoot, "out", "extension.js");
const iconPath = path.join(repoRoot, "resources", "icon.png");
const outputDir = path.join(repoRoot, "preview");
const outputFile = path.join(outputDir, "webview-preview.html");

// ---------------------------------------------------------------------------
// 0. Fail loudly if the extension has not been compiled yet.
// ---------------------------------------------------------------------------
if (!fs.existsSync(extensionEntry)) {
  console.error(`[preview] Compiled extension not found at: ${extensionEntry}`);
  console.error("[preview] Build it first, then re-run this script:");
  console.error("[preview]     npm run compile");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. vscode stub.
//
// `getProfileHtml` only touches two things from the `vscode` namespace:
//   - `webview.cspSource`                                   (a string)
//   - `webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...))`
// We provide a tolerant stub so any incidental usage at module-load time
// (should there ever be one) does not throw either.
// ---------------------------------------------------------------------------

// Embed the real icon as a `data:` URL. Rationale:
//   - The page's CSP already allows `img-src ${cspSource} data:`, so `data:` needs
//     NO CSP relaxation.
//   - A `data:` image does not taint a canvas, so the share-card `canvas.toDataURL()`
//     still works in the browser preview (a file:// image would taint it).
const iconDataUrl = fs.existsSync(iconPath)
  ? `data:image/png;base64,${fs.readFileSync(iconPath).toString("base64")}`
  : "";

const vscodeStub = {
  Uri: {
    // Only used to build the icon path passed to asWebviewUri(); the return value
    // is intentionally opaque because asWebviewUri ignores it in this harness.
    joinPath(uri, ...segments) {
      return { uri, segments };
    },
    file(fsPath) {
      return { fsPath, toString: () => `file://${fsPath}` };
    }
  }
};

// Intercept `require("vscode")` for every module in the dependency graph. This is
// defensive: it works regardless of whether/when the extension gets compiled, and
// it also covers the extension's own local modules (which never import `vscode`,
// but we stay tolerant in case that changes).
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return originalLoad.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// 2. Load the compiled extension and grab the pure HTML builder.
// ---------------------------------------------------------------------------
let getProfileHtml;
try {
  ({ getProfileHtml } = require(extensionEntry));
} catch (error) {
  console.error("[preview] Failed to load the compiled extension:", error);
  process.exit(1);
}

if (typeof getProfileHtml !== "function") {
  console.error("[preview] `getProfileHtml` was not exported from out/extension.js.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Synthetic profile data — believable but OBVIOUSLY FAKE. No real user data.
// ---------------------------------------------------------------------------
function buildPreviewData() {
  const today = new Date();
  const currentYear = today.getFullYear();
  const previousYear = currentYear - 1;

  // Build the heatmap for a full previous year plus the current year up to today,
  // with deterministic (stable) varied counts and some zero-activity days so the
  // heatmap intensity levels and year selector visibly render.
  const heatmap = [];
  const fillYear = (year, endDate) => {
    const date = new Date(year, 0, 1);
    let i = 0;
    while (date.getFullYear() === year && (!endDate || date <= endDate)) {
      const wave = Math.sin(i / 7) * 0.5 + Math.cos(i / 23) * 0.5; // -1..1
      const isZeroDay = i % 11 === 0 || i % 17 === 5;
      const count = isZeroDay ? 0 : Math.max(0, Math.round(1400 + wave * 1100 + (i % 9) * 130));
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      heatmap.push({ date: `${year}-${month}-${day}`, count });
      date.setDate(date.getDate() + 1);
      i += 1;
    }
  };
  fillYear(previousYear, null);
  fillYear(currentYear, today);

  // Synthetic (day, hour) token counts — sparse, deterministic, and obviously fake.
  // Spans the current month (for the default Month view) and part of the previous year.
  const hourlyHeatmap = [];
  const pad2 = (n) => String(n).padStart(2, "0");
  const addHourEntry = (year, month, day, hour, count) => {
    hourlyHeatmap.push({ date: `${year}-${pad2(month)}-${pad2(day)}`, hour, count });
  };
  for (let day = 1; day <= today.getDate(); day++) {
    for (let hour = 0; hour < 24; hour++) {
      if ((day * 7 + hour * 3) % 5 === 0) continue; // leave gaps so zero-cells render
      const count = (day * 131 + hour * 523) % 2200;
      if (count > 0) addHourEntry(currentYear, today.getMonth() + 1, day, hour, count);
    }
  }
  for (let day = 1; day <= 28; day++) {
    for (let hour = 0; hour < 24; hour += 3) {
      const count = (day * 97 + hour * 211) % 1600;
      if (count > 0) addHourEntry(previousYear, 6, day, hour, count);
    }
  }

  const metric = (name, value, detail) => (detail ? { name, value, detail } : { name, value });

  return {
    displayName: "Ada Lovelace",
    username: "ada",
    accountLabel: "ada@example.com",
    accountDetail: "ada@example.com",
    planLabel: "Pro",
    leaderboardUrl: "http://localhost:3000",
    leaderboardPublic: true,
    initials: "AL",
    kiroOpens30d: "42",
    localSessions: "318",
    localSessionsRaw: 318,
    totalTokens: "12.4M",
    totalTokensRaw: 12400000,
    peakTokens: "486.2K",
    totalCredits: "1,842",
    totalCreditsRaw: 1842,
    creditPrice: "$73.68",
    creditUsage: "1842 cr",
    currentStreak: "9",
    currentStreakRaw: 9,
    longestStreak: "27",
    longestStreakRaw: 27,
    activeDays: "214",
    activeDaysRaw: 214,
    heatmap,
    hourlyHeatmap,
    availableYears: [currentYear, previousYear],
    insights: [
      metric("Most productive day", "486.2K tokens", "Tuesday, 3:00 PM"),
      metric("Average session", "39.0K tokens", "across 318 sessions"),
      metric("Favorite model", "kiro-auto", "used 41% of the time"),
      metric("Busiest hour", "2:00 PM", "18% of activity"),
      metric("Spec-driven wins", "12 features", "shipped this month")
    ],
    topItems: [
      metric("TypeScript", "38%"),
      metric("Python", "24%"),
      metric("Rust", "14%"),
      metric("Go", "11%"),
      metric("Markdown", "7%"),
      metric("SQL", "6%")
    ],
    modelItems: [
      metric("kiro-auto", "5,082K", "41%"),
      metric("sonnet-4", "3,410K", "27%"),
      metric("haiku-3", "1,988K", "16%"),
      metric("opus-4", "1,240K", "10%"),
      metric("gpt-4o", "680K", "6%")
    ],
    sessionStats: [
      metric("Total sessions", "318"),
      metric("Total turns", "4,271", "13.4 per session"),
      metric("Failed turns", "63", "1.5%"),
      metric("Avg session length", "24m", "median 18m"),
      metric("CLI sessions", "204", "IDE: 114")
    ],
    tokenStats: [
      metric("Prompt tokens", "8.1M", "65%"),
      metric("Generated tokens", "4.3M", "35%"),
      metric("Tokens per turn", "2,903"),
      metric("Context window peak", "72%", "128K window"),
      metric("Peak day tokens", "486.2K")
    ],
    activityPatterns: [
      metric("Most active day", "Wednesday", "22% of sessions"),
      metric("Lunchtime spike", "12:00–1:00 PM"),
      metric("Night owl", "18% after 9:00 PM"),
      metric("Longest session", "2h 14m"),
      metric("Sub-agent calls", "512")
    ],
    toolStats: [
      metric("read_file", "8,910", "most used tool"),
      metric("replace_string", "3,204"),
      metric("grep_search", "2,771"),
      metric("run_in_terminal", "1,438"),
      metric("file_search", "902"),
      metric("get_errors", "640")
    ],
    systemStats: [
      metric("Log directory", "~/.kiro/logs"),
      metric("Log files scanned", "1,204"),
      metric("Token log rows", "58,332"),
      metric("Kiro app data roots", "2"),
      metric("Last refreshed", "just now")
    ],
    dataSources: [
      metric("Session files", "318"),
      metric("Token logs", "1,204 rows"),
      metric("Hooks", "12"),
      metric("Powers", "5"),
      metric("Extensions", "9")
    ]
  };
}

// ---------------------------------------------------------------------------
// 4. Fake webview: only `cspSource` and `asWebviewUri` are consumed.
// ---------------------------------------------------------------------------
const previewWebview = {
  // `getProfileHtml` splices this into `img-src ${cspSource} data:`. We use `file:`
  // so local images are permitted too. NOTE: no CSP at all is loosened beyond the
  // substitution of cspSource (the icon itself is a data: URL, already allowed).
  cspSource: "file:",
  // Called to resolve the icon used by the share-card canvas. Returns the data: URL
  // built above; see that block for why a data: URL is preferable to a file URL here.
  asWebviewUri() {
    return iconDataUrl || "about:blank";
  }
};

const html = getProfileHtml(previewWebview, { fsPath: repoRoot }, buildPreviewData());

// ---------------------------------------------------------------------------
// 5. Inject the browser shim.
//
// The page's inline script is gated by `script-src 'nonce-...'`, so a separate
// non-nonce'd script would be blocked by `default-src 'none'`. We therefore detect
// the nonce from the generated HTML and reuse it for the shim, inserting the shim
// immediately BEFORE the page's own script so the global exists when it runs.
// ---------------------------------------------------------------------------
const scriptTagMatch = html.match(/<script nonce="([^"]+)">/);
if (!scriptTagMatch) {
  console.error("[preview] Could not locate the nonce'd <script> tag in the generated HTML.");
  process.exit(1);
}
const nonce = scriptTagMatch[1];

const shim = `<script nonce="${nonce}">
    /* ---- Preview harness shim (dev-only; injected by tools/preview-webview.js) ----
       The real webview supplies acquireVsCodeApi(). Here we fake it and record every
       posted message so you can inspect editor-bound messages (refresh, open-leaderboard,
       set-leaderboard-public, share-card) in DevTools via window.__posted. */
    window.acquireVsCodeApi = function () {
      return {
        postMessage: function (message) {
          window.__posted = window.__posted || [];
          window.__posted.push(message);
          console.log("[postMessage]", message);
        },
        getState: function () { return undefined; },
        setState: function () {}
      };
    };
  </script>
  `;

// Use a replacer function so the injected text is treated literally (no $-expansion).
const withShim = html.replace(scriptTagMatch[0], () => shim + scriptTagMatch[0]);

// ---------------------------------------------------------------------------
// 6. Write the preview file.
// ---------------------------------------------------------------------------
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, withShim, "utf8");

console.log(`[preview] Wrote preview HTML: ${outputFile}`);
console.log("[preview] Icon embedded as a data: URL; no CSP relaxation was required.");
console.log("[preview] Open it in a browser:");
console.log(`[preview]     start "" "${outputFile}"   (Windows)`);
console.log("[preview]         open  \"" + outputFile + "\"   (macOS)");
console.log("[preview] Posted messages are logged to the console and kept in window.__posted.");

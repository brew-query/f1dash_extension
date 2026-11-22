/**
 * F1 Dashboard - 4-Factor Overtake Probability Scorer & Highlighter
 *
 * Evaluates consecutive driver pairs on app.formula1dashboard.com using a
 * 4-factor Weighted Heuristic Scoring Model (0 - 99%):
 *   1. Proximity / Interval Gap (strictly < 1.0s)
 *   2. Pace Delta & Closing Rate (Last Lap, Sector deltas & interval trend)
 *   3. Mini-Sector & Sector Color Momentum (Purple / Green vs Yellow)
 *   4. Tire Advantage (Compound softness offset + Tire Age delta in laps)
 */

(() => {
  // Strictly require the interval between the two drivers to be under 1.0 second
  const THRESHOLD_SECONDS = 1.0;

  let isEnabled = true;
  let rafScheduled = false;

  // Stateful tracking of previous intervals per driver pair so we can detect if a chaser is closing in
  // Key: `${aheadDriver}-${chaserDriver}`, Value: { lastInterval: number, delta: number, timestamp: number }
  const intervalHistory = new Map();

  // Known F1 3-letter driver codes (TLA)
  const F1_DRIVER_CODES = new Set([
    "VER", "NOR", "LEC", "PIA", "SAI", "HAM", "RUS", "PER", "ALO", "STR",
    "GAS", "OCO", "ALB", "COL", "TSU", "LAW", "HUL", "MAG", "BOT", "ZHO",
    "BEA", "ANT", "DOO", "BOR", "HAD", "RIC", "SAR", "DEV", "MSC", "VET",
    "RAI", "KUB", "GIO", "LAT", "MAZ", "LIN", "DRU", "POU", "SHW", "HIR"
  ]);

  // Tire compound softness ranking (higher = softer/grippier)
  const TIRE_SOFTNESS_RANK = {
    SOFT: 4,
    S: 4,
    MEDIUM: 3,
    M: 3,
    HARD: 2,
    H: 2,
    INTERMEDIATE: 1,
    INTER: 1,
    I: 1,
    WET: 0,
    W: 0
  };

  // Regex patterns for parsing telemetry tokens inside a driver row
  const INTERVAL_REGEX = /^[+-]?\d{1,3}\.\d{3}s?$/;
  const LAP_TIME_REGEX = /^(\d):(\d{2}\.\d{3})$/; // e.g. "1:26.955"
  const SECTOR_TIME_REGEX = /^[1-6]\d\.\d{3}$/;   // e.g. "22.210" (10.000s - 69.999s)

  /**
   * Parses a lap time string like "1:26.955" into total seconds (86.955).
   */
  function parseLapTimeSeconds(text) {
    if (!text) return null;
    const match = text.trim().match(LAP_TIME_REGEX);
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseFloat(match[2]);
  }

  /**
   * Parses an interval string like "+0.432" into seconds.
   */
  function parseIntervalSeconds(text, requirePlus = true) {
    if (!text) return null;
    const cleaned = text.trim();
    if (!INTERVAL_REGEX.test(cleaned)) return null;
    if (requirePlus && !cleaned.startsWith("+")) return null;

    const numeric = parseFloat(cleaned.replace(/s$/i, ""));
    if (Number.isNaN(numeric) || numeric <= 0) return null;
    return numeric;
  }

  /**
   * Finds all ordered driver row elements (P1 to P20) in the live timing leaderboard.
   */
  function findDriverRows() {
    const tableRows = Array.from(document.querySelectorAll("tbody tr"));
    if (tableRows.length >= 5) {
      return tableRows;
    }

    const codeElements = Array.from(
      document.querySelectorAll("span, div, td, p, strong")
    ).filter((el) => {
      if (el.children.length > 0) return false;
      const txt = el.textContent?.trim().toUpperCase();
      return txt && txt.length === 3 && F1_DRIVER_CODES.has(txt);
    });

    if (codeElements.length < 3) return [];

    const rowSet = new Set();
    for (const codeEl of codeElements) {
      let current = codeEl.parentElement;
      while (current && current !== document.body) {
        const parent = current.parentElement;
        if (parent && parent.children.length >= 5) {
          const rowText = current.innerText || "";
          if (rowText.length >= 6) {
            rowSet.add(current);
            break;
          }
        }
        current = parent;
      }
    }

    return Array.from(rowSet);
  }

  /**
   * Inspects an element's class names, inline styles, and computed RGB color
   * to detect F1 timing colors: Purple (Session Fastest), Green (Personal Best), or Yellow (Slow).
   */
  function classifyTimingColor(el) {
    // Skip position change arrows (e.g. "^ 1", "^ 16") or tire badges
    const txt = el.textContent?.trim() || "";
    if (/^[▲▼↑↓+-]?\d{1,2}$/.test(txt) || /^[SMHIW]$/.test(txt)) {
      return null;
    }

    const classAndStyle = `${el.className || ""} ${el.getAttribute("style") || ""}`.toLowerCase();

    if (/purple|violet|fuchsia|fastest|overall/.test(classAndStyle)) return "purple";
    if (/green|emerald|personal|pb/.test(classAndStyle)) return "green";
    if (/yellow|amber|slow/.test(classAndStyle)) return "yellow";

    const style = window.getComputedStyle(el);
    for (const prop of [style.backgroundColor, style.color]) {
      const rgb = prop && prop.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
      if (!rgb) continue;
      const r = Number(rgb[1]);
      const g = Number(rgb[2]);
      const b = Number(rgb[3]);
      const a = rgb[4] !== undefined ? Number(rgb[4]) : 1;
      if (a < 0.15) continue;

      if (r > 130 && b > 160 && g < 120) return "purple";
      if (g > 150 && r < 110 && b < 160) return "green";
      if (r > 180 && g > 140 && b < 90) return "yellow";
    }

    return null;
  }

  /**
   * Extracts a complete telemetry snapshot from a single driver row:
   * - driverCode (e.g., "VER")
   * - interval (seconds to car ahead, i.e., the 2nd '+' column on P2..P20) & intervalCell
   * - lastLap & bestLap (in seconds, e.g., 1:26.955 and 1:26.467)
   * - sectors (array of sector times in seconds)
   * - miniSectors ({ purple, green, yellow })
   * - tireCompound ("S", "M", "H", "I", "W") & tireAge (number of laps on current tire)
   */
  function extractDriverTelemetry(rowElement, rowIndex) {
    const telemetry = {
      driverCode: `P${rowIndex + 1}`,
      inPitOrOut: false,
      interval: null,
      intervalCell: null,
      lapTimes: [],
      sectors: [],
      miniSectors: { purple: 0, green: 0, yellow: 0 },
      tireCompound: null,
      tireAge: null
    };

    const rowTextUpper = (rowElement.innerText || "").toUpperCase();
    if (/\b(PIT|IN PIT|OUT|RET|DNF|DNS|STOP)\b/.test(rowTextUpper)) {
      telemetry.inPitOrOut = true;
      return telemetry;
    }

    // Walk all elements inside the row (excluding our own injected score badge)
    const allElements = Array.from(rowElement.querySelectorAll("*")).filter(
      (el) => !el.classList.contains("f1-overtake-score-badge")
    );

    const plusCandidates = [];

    for (let idx = 0; idx < allElements.length; idx++) {
      const el = allElements[idx];

      // 1. Check for mini-sector / sector color bars or colored sector text
      const colorType = classifyTimingColor(el);
      if (colorType) {
        telemetry.miniSectors[colorType]++;
      }

      // Only inspect leaf text nodes for numeric / text values
      if (el.children.length > 0) continue;
      const rawText = el.textContent?.trim();
      if (!rawText) continue;
      const upperText = rawText.toUpperCase();

      // 2. Driver 3-letter code (e.g., "HAD", "VER", "LAW")
      if (upperText.length === 3 && F1_DRIVER_CODES.has(upperText)) {
        telemetry.driverCode = upperText;
        continue;
      }

      // 3. Lap times (e.g., Last Lap "1:26.955", Best Lap "1:26.467")
      const lapSec = parseLapTimeSeconds(rawText);
      if (lapSec !== null) {
        telemetry.lapTimes.push(lapSec);
        continue;
      }

      // 4. Sector times (e.g., "22.210", "45.148", "18.953" — without a '+' prefix)
      if (!rawText.startsWith("+") && SECTOR_TIME_REGEX.test(rawText)) {
        const secVal = parseFloat(rawText);
        if (secVal >= 14.0 && secVal <= 68.0) {
          telemetry.sectors.push(secVal);
          continue;
        }
      }

      // 5. Tire Compound letter ("S", "M", "H", "I", "W") and the Tire Age integer right after it
      if (/^[SMHIW]$/.test(upperText)) {
        telemetry.tireCompound = upperText;
        // Look at the next leaf element(s) in the row for the tire age integer (e.g. "10")
        for (let nextIdx = idx + 1; nextIdx < Math.min(allElements.length, idx + 5); nextIdx++) {
          const nextEl = allElements[nextIdx];
          if (nextEl.children.length > 0) continue;
          const nextTxt = nextEl.textContent?.trim();
          if (nextTxt && /^\d{1,2}L?$/i.test(nextTxt)) {
            telemetry.tireAge = parseInt(nextTxt, 10);
            break;
          }
        }
        continue;
      }

      // 6. Gap to Leader & Interval to Car Ahead (e.g., "+15.362" and "+5.086")
      if (rowIndex > 0) {
        const plusVal = parseIntervalSeconds(rawText, true);
        if (plusVal !== null) {
          plusCandidates.push({ val: plusVal, node: el });
        }
      }
    }

    // On app.formula1dashboard.com, each row has [Gap to Leader, Interval to Car Ahead].
    // If there are 2 '+' values (e.g., +15.362 and +5.086), the 2nd one (and smaller one) is the Interval.
    if (plusCandidates.length >= 2) {
      // Pick the last '+' column (Interval column), or the minimum value
      const intervalCandidate = plusCandidates[plusCandidates.length - 1];
      telemetry.interval = intervalCandidate.val;
      telemetry.intervalCell = intervalCandidate.node;
    } else if (plusCandidates.length === 1) {
      telemetry.interval = plusCandidates[0].val;
      telemetry.intervalCell = plusCandidates[0].node;
    }

    return telemetry;
  }

  /**
   * Computes the 4-Factor Overtake Probability Score (0 - 99%) for a Chaser vs. Car Ahead.
   * Strictly requires chaser.interval < 1.0s.
   */
  function calculateOvertakeProbability(ahead, chaser) {
    if (ahead.inPitOrOut || chaser.inPitOrOut) return null;
    if (chaser.interval === null || chaser.interval <= 0) return null;

    // Strictly enforce < 1.0 second interval threshold
    if (chaser.interval >= THRESHOLD_SECONDS) return null;

    let score = 0;
    const reasons = [];

    // ------------------------------------------------------------------------
    // FACTOR 1: Proximity / Interval Gap (< 1.0s) (24 to 50 points)
    // ------------------------------------------------------------------------
    const gap = chaser.interval;
    // Smooth curve: 0.2s -> 48 pts, 0.5s -> 39 pts, 0.8s -> 30 pts, 0.99s -> 24 pts
    const proximityPts = Math.round(Math.max(24, 54 - gap * 30));
    score += proximityPts;
    reasons.push(`Gap +${gap.toFixed(3)}s (+${proximityPts})`);

    // ------------------------------------------------------------------------
    // FACTOR 2: Pace Delta & Interval Closing Trend (-10 to +24 points)
    // ------------------------------------------------------------------------
    let pacePts = 0;

    // 2a. Interval Closing Trend
    const pairKey = `${ahead.driverCode}-${chaser.driverCode}`;
    const now = Date.now();
    const prevRecord = intervalHistory.get(pairKey);

    let intervalDelta = 0;
    if (prevRecord) {
      if (Math.abs(gap - prevRecord.lastInterval) >= 0.005) {
        intervalDelta = gap - prevRecord.lastInterval; // Negative means chaser is getting closer
        intervalHistory.set(pairKey, {
          lastInterval: gap,
          delta: intervalDelta,
          timestamp: now
        });
      } else {
        intervalDelta = prevRecord.delta;
      }
    } else {
      intervalHistory.set(pairKey, { lastInterval: gap, delta: 0, timestamp: now });
    }

    if (intervalDelta < -0.02) {
      const closingBoost = Math.min(12, Math.round(Math.abs(intervalDelta) * 35));
      pacePts += closingBoost;
      reasons.push(`Closing ${intervalDelta.toFixed(3)}s (+${closingBoost})`);
    } else if (intervalDelta > 0.05) {
      pacePts -= 6;
      reasons.push(`Dropping back (-6)`);
    }

    // 2b. Last Lap Time Comparison (first lap time in each row is Last Lap, e.g. 1:26.955 vs 1:27.342)
    if (ahead.lapTimes.length > 0 && chaser.lapTimes.length > 0) {
      const lastLapGain = ahead.lapTimes[0] - chaser.lapTimes[0]; // Positive = chaser was faster last lap
      if (lastLapGain > 0.05) {
        const lapPts = Math.min(12, Math.round(lastLapGain * 18));
        pacePts += lapPts;
        reasons.push(`Last lap -${lastLapGain.toFixed(3)}s faster (+${lapPts})`);
      } else if (lastLapGain < -0.15) {
        pacePts -= 4;
      }
    }

    // 2c. Sector Times Comparison
    const sharedSectors = Math.min(ahead.sectors.length, chaser.sectors.length);
    if (sharedSectors > 0) {
      // Compare the first (current) sector numbers
      const s1Gain = ahead.sectors[0] - chaser.sectors[0];
      if (s1Gain > 0.05) {
        const secPts = Math.min(8, Math.round(s1Gain * 20));
        pacePts += secPts;
        reasons.push(`Sector -${s1Gain.toFixed(3)}s faster (+${secPts})`);
      }
    }

    score += Math.max(-10, Math.min(24, pacePts));

    // ------------------------------------------------------------------------
    // FACTOR 3: Mini-Sector & Sector Color Momentum (0 to +14 points)
    // ------------------------------------------------------------------------
    const chaserFastSegments = chaser.miniSectors.purple * 3 + chaser.miniSectors.green * 2;
    const aheadFastSegments = ahead.miniSectors.purple * 3 + ahead.miniSectors.green * 2;

    if (chaserFastSegments > aheadFastSegments) {
      const momentumPts = Math.min(14, (chaserFastSegments - aheadFastSegments) * 2);
      score += momentumPts;
      reasons.push(`Purple/Green mini-sectors (+${momentumPts})`);
    }

    // ------------------------------------------------------------------------
    // FACTOR 4: Tire Compound & Tire Age Advantage (-6 to +14 points)
    // ------------------------------------------------------------------------
    let tirePts = 0;

    const aheadRank = TIRE_SOFTNESS_RANK[ahead.tireCompound];
    const chaserRank = TIRE_SOFTNESS_RANK[chaser.tireCompound];
    if (aheadRank !== undefined && chaserRank !== undefined && chaserRank !== aheadRank) {
      const compoundDiff = chaserRank - aheadRank;
      const compPts = compoundDiff * 5;
      tirePts += compPts;
      reasons.push(
        `Tire ${chaser.tireCompound} vs ${ahead.tireCompound} (${compPts > 0 ? "+" : ""}${compPts})`
      );
    }

    if (ahead.tireAge !== null && chaser.tireAge !== null) {
      const ageAdvantage = ahead.tireAge - chaser.tireAge;
      if (Math.abs(ageAdvantage) >= 2) {
        const agePts = Math.max(-5, Math.min(10, Math.round(ageAdvantage * 0.8)));
        if (agePts !== 0) {
          tirePts += agePts;
          reasons.push(
            `${Math.abs(ageAdvantage)}L ${ageAdvantage > 0 ? "fresher" : "older"} tires (${agePts > 0 ? "+" : ""}${agePts})`
          );
        }
      }
    }

    score += Math.max(-6, Math.min(14, tirePts));

    const finalScore = Math.max(15, Math.min(99, score));
    const tier = finalScore >= 70 ? "high" : finalScore >= 45 ? "med" : "low";

    return {
      score: finalScore,
      tier,
      breakdown: reasons.join(" • ")
    };
  }

  /**
   * Injects or updates the inline probability badge next to the chaser's interval cell,
   * and returns the badge element so we can track and clean up any orphaned badges.
   */
  function renderScoreBadge(cell, result) {
    if (!cell || !cell.parentElement) return null;

    let badge = cell.parentElement.querySelector(".f1-overtake-score-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "f1-overtake-score-badge";
      cell.insertAdjacentElement("afterend", badge);
    }

    badge.className = `f1-overtake-score-badge tier-${result.tier}`;
    const icon = result.tier === "high" ? "🔥" : result.tier === "med" ? "⚡" : "👀";
    const text = `${icon} ${result.score}%`;
    if (badge.textContent !== text) {
      badge.textContent = text;
    }
    badge.title = `Overtake Probability: ${result.score}%\n${result.breakdown}`;
    return badge;
  }

  /**
   * Clears all custom classes and badges added by our extension.
   */
  function clearAllHighlights() {
    document
      .querySelectorAll(
        ".f1-overtake-active, .f1-overtake-ahead, .f1-overtake-chaser, .f1-overtake-tier-high, .f1-overtake-tier-med, .f1-overtake-tier-low, .f1-overtake-interval-cell"
      )
      .forEach((el) => {
        el.classList.remove(
          "f1-overtake-active",
          "f1-overtake-ahead",
          "f1-overtake-chaser",
          "f1-overtake-tier-high",
          "f1-overtake-tier-med",
          "f1-overtake-tier-low",
          "f1-overtake-interval-cell"
        );
      });

    document.querySelectorAll(".f1-overtake-score-badge").forEach((b) => b.remove());
  }

  /**
   * Main scan function: evaluates all consecutive driver pairs and renders highlights + scores.
   */
  function updateOvertakeHighlights() {
    rafScheduled = false;

    if (!isEnabled) {
      clearAllHighlights();
      updateStatusPill(0, 0);
      return;
    }

    const rows = findDriverRows();
    if (rows.length < 2) {
      clearAllHighlights();
      updateStatusPill(0, 0, true);
      return;
    }

    // Extract telemetry snapshot for all rows first
    const snapshots = rows.map((row, idx) => extractDriverTelemetry(row, idx));

    const aheadRowIndices = new Set();
    const chaserRowIndices = new Set();
    const rowHighestTier = new Map(); // rowIndex -> "high" | "med" | "low"
    const activeCells = new Map();    // cellElement -> result

    let battleCount = 0;
    let maxScore = 0;

    const tierPriority = { low: 1, med: 2, high: 3 };
    const setRowTier = (idx, tier) => {
      const existing = rowHighestTier.get(idx);
      if (!existing || tierPriority[tier] > tierPriority[existing]) {
        rowHighestTier.set(idx, tier);
      }
    };

    for (let i = 1; i < rows.length; i++) {
      const ahead = snapshots[i - 1];
      const chaser = snapshots[i];
      const result = calculateOvertakeProbability(ahead, chaser);

      if (result) {
        aheadRowIndices.add(i - 1);
        chaserRowIndices.add(i);
        setRowTier(i - 1, result.tier);
        setRowTier(i, result.tier);

        if (chaser.intervalCell) {
          activeCells.set(chaser.intervalCell, result);
        }

        battleCount++;
        if (result.score > maxScore) maxScore = result.score;
      }
    }

    // Update row classes cleanly
    rows.forEach((row, idx) => {
      const tier = rowHighestTier.get(idx);
      const isActive = Boolean(tier);

      row.classList.toggle("f1-overtake-active", isActive);
      row.classList.toggle("f1-overtake-ahead", aheadRowIndices.has(idx));
      row.classList.toggle("f1-overtake-chaser", chaserRowIndices.has(idx));
      row.classList.toggle("f1-overtake-tier-high", tier === "high");
      row.classList.toggle("f1-overtake-tier-med", tier === "med");
      row.classList.toggle("f1-overtake-tier-low", tier === "low");
    });

    // Apply current cell highlights and render live score badges, tracking every valid badge
    const activeBadges = new Set();
    activeCells.forEach((result, cell) => {
      cell.classList.add("f1-overtake-interval-cell");
      const badge = renderScoreBadge(cell, result);
      if (badge) activeBadges.add(badge);
    });

    // Clean up any cell classes that are no longer active
    document.querySelectorAll(".f1-overtake-interval-cell").forEach((cell) => {
      if (!activeCells.has(cell)) {
        cell.classList.remove("f1-overtake-interval-cell");
      }
    });

    // Directly sweep and remove ANY score badge on the page that is no longer active!
    // This guarantees badges never get stuck if React re-renders or replaces the interval node.
    document.querySelectorAll(".f1-overtake-score-badge").forEach((badge) => {
      if (!activeBadges.has(badge)) {
        badge.remove();
      }
    });

    updateStatusPill(battleCount, maxScore, false);
  }

  /**
   * Schedules a highlight check on the next animation frame (Debouncing pattern).
   */
  function scheduleUpdate() {
    if (!rafScheduled) {
      rafScheduled = true;
      window.requestAnimationFrame(updateOvertakeHighlights);
    }
  }

  /**
   * Updates the floating status pill in the bottom-right corner.
   */
  function updateStatusPill(battleCount, maxScore, waitingForBoard = false) {
    let pill = document.getElementById("f1-overtake-status-pill");
    if (!pill) {
      pill = document.createElement("div");
      pill.id = "f1-overtake-status-pill";
      pill.title = "Click to toggle Overtake <1.0s Probability Scorer";
      pill.addEventListener("click", () => {
        isEnabled = !isEnabled;
        pill.classList.toggle("f1-disabled", !isEnabled);
        scheduleUpdate();
      });
      document.body.appendChild(pill);
    }

    const peakText = maxScore > 0 ? ` (Peak ${maxScore}%)` : "";
    const label = !isEnabled
      ? "Overtake <1.0s: OFF"
      : waitingForBoard
        ? "Overtake <1.0s: Waiting for timing..."
        : `Overtake <1.0s: ${battleCount} battle${battleCount === 1 ? "" : "s"}${peakText}`;

    const desiredHTML = `<span class="f1-dot"></span><span>${label}</span>`;
    if (pill.innerHTML !== desiredHTML) {
      pill.innerHTML = desiredHTML;
    }
  }

  // Initial scan once the page loads
  scheduleUpdate();

  // Watch for live-timing updates using MutationObserver
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const target = m.target?.nodeType === 1 ? m.target : m.target?.parentElement;
      if (
        target &&
        target.id !== "f1-overtake-status-pill" &&
        !target.closest?.("#f1-overtake-status-pill") &&
        !target.classList?.contains("f1-overtake-score-badge") &&
        !target.closest?.(".f1-overtake-score-badge")
      ) {
        scheduleUpdate();
        break;
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });
})();

import { mkdir, readFile, writeFile } from "node:fs/promises";

const username = process.env.GITHUB_USERNAME || "spongeBor";
const token = process.env.GITHUB_TOKEN;
const fixture = process.env.ACTIVITY_FIXTURE;
const outputDir = process.env.ACTIVITY_OUTPUT_DIR || "assets";

const dayMs = 86_400_000;
const today = new Date();
const toDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
const fromDate = new Date(toDate.getTime() - 365 * dayMs);

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

async function loadContributionDays() {
  if (fixture) {
    const parsed = JSON.parse(await readFile(fixture, "utf8"));
    return parsed.contributions.map(({ date, count }) => ({ date, count }));
  }

  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const query = `
    query ActivityCalendar($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
                contributionLevel
              }
            }
          }
        }
      }
    }
  `;

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": `${username}-profile-activity-card`,
    },
    body: JSON.stringify({
      query,
      variables: {
        login: username,
        from: `${isoDate(fromDate)}T00:00:00Z`,
        to: `${isoDate(toDate)}T23:59:59Z`,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  if (result.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${result.errors.map((error) => error.message).join("; ")}`);
  }

  const calendar = result.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) {
    throw new Error(`No contribution calendar returned for ${username}`);
  }

  return calendar.weeks
    .flatMap((week) => week.contributionDays)
    .map((day) => ({ date: day.date, count: day.contributionCount }))
    .filter((day) => day.date >= isoDate(fromDate) && day.date <= isoDate(toDate))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function summarize(days) {
  let activeDays = 0;
  let longestStreak = 0;
  let runningStreak = 0;
  let peak = { date: "", count: 0 };

  for (const day of days) {
    if (day.count > 0) {
      activeDays += 1;
      runningStreak += 1;
      longestStreak = Math.max(longestStreak, runningStreak);
    } else {
      runningStreak = 0;
    }
    if (day.count > peak.count) peak = day;
  }

  const total = days.reduce((sum, day) => sum + day.count, 0);
  const monthKeys = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(toDate.getUTCFullYear(), toDate.getUTCMonth() - offset, 1));
    monthKeys.push(date.toISOString().slice(0, 7));
  }
  const monthTotals = new Map(monthKeys.map((key) => [key, 0]));
  for (const day of days) {
    const key = day.date.slice(0, 7);
    if (monthTotals.has(key)) monthTotals.set(key, monthTotals.get(key) + day.count);
  }

  return {
    total,
    activeDays,
    longestStreak,
    average: days.length ? total / days.length : 0,
    peak,
    months: [...monthTotals].map(([key, value]) => ({ key, value })),
  };
}

const themes = {
  light: {
    background: "#ffffff",
    surface: "#f6f8fa",
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#656d76",
    grid: "#d8dee4",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    bar: "#1f883d",
  },
  dark: {
    background: "#0d1117",
    surface: "#161b22",
    border: "#30363d",
    text: "#f0f6fc",
    muted: "#8b949e",
    grid: "#30363d",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    bar: "#39d353",
  },
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function levelFor(count, peakCount) {
  if (count === 0 || peakCount === 0) return 0;
  const ratio = count / peakCount;
  if (ratio <= 0.12) return 1;
  if (ratio <= 0.3) return 2;
  if (ratio <= 0.6) return 3;
  return 4;
}

function renderCard(days, stats, themeName) {
  const theme = themes[themeName];
  const width = 920;
  const height = 530;
  const start = new Date(`${days[0].date}T00:00:00Z`);
  const startWeekday = start.getUTCDay();
  const heatX = 92;
  const heatY = 220;
  const cell = 11;
  const gap = 3;
  const step = cell + gap;
  const maxMonth = Math.max(1, ...stats.months.map((month) => month.value));

  const heatCells = days.map((day, index) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    const slot = startWeekday + index;
    const column = Math.floor(slot / 7);
    const row = date.getUTCDay();
    const level = levelFor(day.count, stats.peak.count);
    return `<g><title>${escapeXml(day.date)} · ${day.count} contributions</title><rect x="${heatX + column * step}" y="${heatY + row * step}" width="${cell}" height="${cell}" rx="2" fill="${theme.levels[level]}" /></g>`;
  }).join("");

  const monthLabels = [];
  let previousMonth = days[0].date.slice(0, 7);
  days.forEach((day, index) => {
    const month = day.date.slice(0, 7);
    if (month !== previousMonth) {
      const slot = startWeekday + index;
      const column = Math.floor(slot / 7);
      const label = new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      monthLabels.push(`<text x="${heatX + column * step}" y="202" class="small muted">${label}</text>`);
      previousMonth = month;
    }
  });

  const monthSlot = 760 / stats.months.length;
  const barBaseY = 486;
  const barMaxHeight = 92;
  const monthBars = stats.months.map((month, index) => {
    const barHeight = (month.value / maxMonth) * barMaxHeight;
    const x = 92 + index * monthSlot + 12;
    const barWidth = monthSlot - 24;
    const label = new Date(`${month.key}-01T00:00:00Z`).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    return `
      <g>
        <title>${escapeXml(month.key)} · ${month.value} contributions</title>
        <rect x="${x.toFixed(1)}" y="${(barBaseY - barHeight).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="4" fill="${theme.bar}" />
        <text x="${(x + barWidth / 2).toFixed(1)}" y="${(barBaseY - barHeight - 7).toFixed(1)}" class="tiny value" text-anchor="middle">${month.value}</text>
        <text x="${(x + barWidth / 2).toFixed(1)}" y="510" class="tiny muted" text-anchor="middle">${label}</text>
      </g>`;
  }).join("");

  const legend = theme.levels.map((color, index) => `<rect x="${730 + index * 19}" y="328" width="13" height="13" rx="2" fill="${color}"${index === 0 ? ` stroke="${theme.border}"` : ""} />`).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(username)} GitHub activity</title>
  <desc id="desc">${stats.total} contributions across ${stats.activeDays} active days during the last year. Longest streak: ${stats.longestStreak} days.</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .heading { font-size: 20px; font-weight: 600; fill: ${theme.text}; }
    .label { font-size: 13px; fill: ${theme.muted}; }
    .metric { font-size: 30px; font-weight: 600; fill: ${theme.text}; }
    .small { font-size: 12px; fill: ${theme.text}; }
    .tiny { font-size: 11px; fill: ${theme.text}; }
    .muted { fill: ${theme.muted}; }
    .value { fill: ${theme.text}; }
  </style>
  <rect x="1" y="1" width="918" height="528" rx="14" fill="${theme.background}" stroke="${theme.border}" />
  <text x="34" y="42" class="heading">Engineering activity</text>
  <text x="886" y="42" class="small muted" text-anchor="end">Updated ${isoDate(toDate)}</text>

  <rect x="34" y="66" width="264" height="92" rx="10" fill="${theme.surface}" stroke="${theme.border}" />
  <text x="54" y="92" class="label">Contributions · last year</text>
  <text x="54" y="132" class="metric">${stats.total.toLocaleString("en-US")}</text>

  <rect x="328" y="66" width="264" height="92" rx="10" fill="${theme.surface}" stroke="${theme.border}" />
  <text x="348" y="92" class="label">Active days</text>
  <text x="348" y="132" class="metric">${stats.activeDays}</text>

  <rect x="622" y="66" width="264" height="92" rx="10" fill="${theme.surface}" stroke="${theme.border}" />
  <text x="642" y="92" class="label">Longest streak</text>
  <text x="642" y="132" class="metric">${stats.longestStreak} days</text>

  <text x="34" y="188" class="heading">Year overview</text>
  <text x="886" y="188" class="small muted" text-anchor="end">Avg ${stats.average.toFixed(1)}/day · Peak ${stats.peak.count} on ${escapeXml(stats.peak.date)}</text>
  <text x="50" y="248" class="tiny muted">Mon</text>
  <text x="50" y="276" class="tiny muted">Wed</text>
  <text x="50" y="304" class="tiny muted">Fri</text>
  ${monthLabels.join("")}
  ${heatCells}
  <text x="706" y="339" class="tiny muted" text-anchor="end">Less</text>
  ${legend}
  <text x="838" y="339" class="tiny muted">More</text>

  <line x1="34" y1="365" x2="886" y2="365" stroke="${theme.grid}" />
  <text x="34" y="397" class="heading">Monthly trend</text>
  <text x="886" y="397" class="small muted" text-anchor="end">Aggregated public + anonymized private activity</text>
  <line x1="92" y1="486" x2="852" y2="486" stroke="${theme.grid}" />
  ${monthBars}
</svg>`;
}

const days = await loadContributionDays();
if (!days.length) throw new Error("No contribution days returned");
const stats = summarize(days);

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(`${outputDir}/github-activity-light.svg`, renderCard(days, stats, "light"), "utf8"),
  writeFile(`${outputDir}/github-activity-dark.svg`, renderCard(days, stats, "dark"), "utf8"),
]);

console.log(`Generated activity cards for ${username}: ${stats.total} contributions, ${stats.activeDays} active days`);

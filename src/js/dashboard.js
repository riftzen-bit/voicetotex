const SVG_NS = 'http://www.w3.org/2000/svg';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HEATMAP_WEEKS = 15;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;
const HEATMAP_CELL = 12;
const HEATMAP_GAP = 3;
function toDayKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function parseDateKey(dateKey) {
  if (!dateKey || typeof dateKey !== 'string') return null;
  const parts = dateKey.split('-');
  if (parts.length !== 3) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const day = Number(parts[2]);
  const parsed = new Date(year, month, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function normalizeDailyLog(dailyLog) {
  const safeLog = dailyLog && typeof dailyLog === 'object' ? dailyLog : {};
  const map = new Map();
  for (const [key, value] of Object.entries(safeLog)) {
    const parsed = parseDateKey(key);
    if (!parsed || !value || typeof value !== 'object') continue;
    map.set(toDayKey(parsed), {
      count: Number(value.count) || 0,
      words: Number(value.words) || 0,
      duration: Number(value.duration) || 0,
      languages: Array.isArray(value.languages) ? value.languages : [],
    });
  }
  return map;
}
function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}
function formatDateShort(date) {
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
}
function createSvgIcon(pathCommands) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const command of pathCommands) {
    const node = document.createElementNS(SVG_NS, command.type);
    for (const [attr, val] of Object.entries(command.attrs)) {
      node.setAttribute(attr, val);
    }
    svg.appendChild(node);
  }
  return svg;
}
function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
function createStatCard(label, value, iconSvg) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  const iconWrap = document.createElement('div');
  iconWrap.className = 'stat-card-icon';
  iconWrap.appendChild(iconSvg);
  const valueEl = document.createElement('div');
  valueEl.className = 'stat-card-value';
  valueEl.textContent = value;
  const labelEl = document.createElement('div');
  labelEl.className = 'stat-card-label';
  labelEl.textContent = label;
  card.appendChild(iconWrap);
  card.appendChild(valueEl);
  card.appendChild(labelEl);
  return card;
}
function getHeatColor(count) {
  if (count <= 0) return '#1a1a1a';
  if (count <= 2) return '#3d1a1a';
  if (count <= 5) return '#8b2020';
  return '#ff4444';
}
function renderHeatmapSection(dailyMap) {
  const section = document.createElement('section');
  section.className = 'dashboard-section dashboard-activity';
  const heading = document.createElement('div');
  heading.className = 'dashboard-section-header';

  const title = document.createElement('h3');
  title.className = 'dashboard-section-title';
  title.textContent = 'Activity';
  const endDate = new Date();
  endDate.setHours(0, 0, 0, 0);
  const startDate = new Date(endDate.getTime() - (HEATMAP_DAYS - 1) * MS_PER_DAY);
  const subtitle = document.createElement('p');
  subtitle.className = 'dashboard-section-subtitle';
  subtitle.textContent = `${formatDateShort(startDate)} - ${formatDateShort(endDate)}`;
  heading.appendChild(title);
  heading.appendChild(subtitle);
  const chartWrap = document.createElement('div');
  chartWrap.className = 'heatmap-wrap';

  const leftLabels = document.createElement('div');
  leftLabels.className = 'heatmap-day-labels';
  leftLabels.appendChild(document.createElement('span')).textContent = 'M';
  leftLabels.appendChild(document.createElement('span')).textContent = 'W';
  leftLabels.appendChild(document.createElement('span')).textContent = 'F';
  const content = document.createElement('div');
  content.className = 'heatmap-content';

  const monthLabels = document.createElement('div');
  monthLabels.className = 'heatmap-month-labels';
  const svgWidth = HEATMAP_WEEKS * (HEATMAP_CELL + HEATMAP_GAP) - HEATMAP_GAP;
  const svgHeight = 7 * (HEATMAP_CELL + HEATMAP_GAP) - HEATMAP_GAP;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('activity-heatmap');
  svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
  svg.setAttribute('width', String(svgWidth));
  svg.setAttribute('height', String(svgHeight));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily activity heatmap');
  let previousMonth = '';
  for (let index = 0; index < HEATMAP_DAYS; index++) {
    const currentDate = new Date(startDate.getTime() + index * MS_PER_DAY);
    const day = (currentDate.getDay() + 6) % 7;
    const week = Math.floor(index / 7);
    const x = week * (HEATMAP_CELL + HEATMAP_GAP);
    const y = day * (HEATMAP_CELL + HEATMAP_GAP);
    const dateKey = toDayKey(currentDate);
    const count = dailyMap.get(dateKey)?.count || 0;
    if ((day === 0 || index === 0) && currentDate.getDate() <= 7) {
      const month = currentDate.toLocaleDateString([], { month: 'short' });
      if (month !== previousMonth) {
        const monthLabel = document.createElement('span');
        monthLabel.className = 'heatmap-month-label';
        monthLabel.textContent = month;
        monthLabel.style.left = `${x}px`;
        monthLabels.appendChild(monthLabel);
        previousMonth = month;
      }
    }
    const cell = document.createElementNS(SVG_NS, 'rect');
    cell.setAttribute('x', String(x));
    cell.setAttribute('y', String(y));
    cell.setAttribute('width', String(HEATMAP_CELL));
    cell.setAttribute('height', String(HEATMAP_CELL));
    cell.setAttribute('rx', '3');
    cell.setAttribute('ry', '3');
    cell.setAttribute('fill', getHeatColor(count));
    cell.setAttribute('title', `${count} transcriptions on ${dateKey}`);
    const tooltip = document.createElementNS(SVG_NS, 'title');
    tooltip.textContent = `${count} transcriptions on ${dateKey}`;
    cell.appendChild(tooltip);
    svg.appendChild(cell);
  }
  content.appendChild(monthLabels);
  content.appendChild(svg);
  chartWrap.appendChild(leftLabels);
  chartWrap.appendChild(content);
  section.appendChild(heading);
  section.appendChild(chartWrap);
  return section;
}
function renderDailyBarSection(dailyMap) {
  const section = document.createElement('section');
  section.className = 'dashboard-section dashboard-daily-chart';
  const title = document.createElement('h3');
  title.className = 'dashboard-section-title';
  title.textContent = 'Daily Activity';
  section.appendChild(title);
  const bars = document.createElement('div');
  bars.className = 'daily-bars';

  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const day = new Date(today.getTime() - i * MS_PER_DAY);
    const dateKey = toDayKey(day);
    const count = dailyMap.get(dateKey)?.count || 0;
    days.push({ date: day, count });
  }
  const maxCount = Math.max(1, ...days.map(day => day.count));
  for (const day of days) {
    const item = document.createElement('div');
    item.className = 'daily-bar-item';
    const countEl = document.createElement('div');
    countEl.className = 'daily-bar-count';
    countEl.textContent = String(day.count);
    const track = document.createElement('div');
    track.className = 'daily-bar-track';
    const bar = document.createElement('div');
    bar.className = 'daily-bar-fill';
    bar.style.height = `${Math.max(4, Math.round((day.count / maxCount) * 100))}%`;
    bar.title = `${day.count} transcriptions on ${toDayKey(day.date)}`;
    track.appendChild(bar);
    const label = document.createElement('div');
    label.className = 'daily-bar-label';
    label.textContent = day.date.toLocaleDateString([], { weekday: 'short' });
    item.appendChild(countEl);
    item.appendChild(track);
    item.appendChild(label);
    bars.appendChild(item);
  }
  section.appendChild(bars);
  return section;
}
function renderLanguagesSection(dailyMap) {
  const section = document.createElement('section');
  section.className = 'dashboard-section dashboard-language-chart';
  const title = document.createElement('h3');
  title.className = 'dashboard-section-title';
  title.textContent = 'Languages';
  section.appendChild(title);
  const counts = new Map();
  for (const day of dailyMap.values()) {
    for (const rawLang of day.languages) {
      const lang = String(rawLang || '').trim().toLowerCase();
      if (!lang) continue;
      counts.set(lang, (counts.get(lang) || 0) + 1);
    }
  }
  const rows = document.createElement('div');
  rows.className = 'language-bars';

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const max = sorted.length > 0 ? sorted[0][1] : 0;
  const total = sorted.reduce((sum, item) => sum + item[1], 0);
  if (sorted.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'dashboard-empty-state';
    empty.textContent = 'No language activity yet.';
    section.appendChild(empty);
    return section;
  }
  for (const [lang, count] of sorted) {
    const row = document.createElement('div');
    row.className = 'language-bar-row';
    const label = document.createElement('div');
    label.className = 'language-bar-label';
    label.textContent = lang.toUpperCase();
    const track = document.createElement('div');
    track.className = 'language-bar-track';
    const fill = document.createElement('div');
    fill.className = 'language-bar-fill';
    fill.style.width = `${Math.max(3, Math.round((count / max) * 100))}%`;
    track.appendChild(fill);
    const value = document.createElement('div');
    value.className = 'language-bar-value';
    const percent = total > 0 ? Math.round((count / total) * 100) : 0;
    value.textContent = `${count} (${percent}%)`;
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(value);
    rows.appendChild(row);
  }
  section.appendChild(rows);
  return section;
}
export function renderDashboard(container, rewardsData) {
  if (!container) return;
  container.innerHTML = '';
  if (!rewardsData || typeof rewardsData !== 'object') {
    const empty = document.createElement('div');
    empty.className = 'dashboard-empty-state';
    empty.textContent = 'No data yet. Start transcribing to see your stats!';
    container.appendChild(empty);
    return;
  }
  const dailyMap = normalizeDailyLog(rewardsData.daily_log);
  const dashboard = document.createElement('div');
  dashboard.className = 'dashboard-content';
  const stats = document.createElement('section');
  stats.className = 'dashboard-stats-grid';
  const micIcon = createSvgIcon([
    { type: 'path', attrs: { d: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z' } },
    { type: 'path', attrs: { d: 'M19 10a7 7 0 0 1-14 0' } },
    { type: 'path', attrs: { d: 'M12 17v4' } },
    { type: 'path', attrs: { d: 'M8 21h8' } },
  ]);
  const textIcon = createSvgIcon([
    { type: 'path', attrs: { d: 'M4 6h16' } },
    { type: 'path', attrs: { d: 'M4 12h16' } },
    { type: 'path', attrs: { d: 'M4 18h10' } },
  ]);
  const clockIcon = createSvgIcon([
    { type: 'circle', attrs: { cx: '12', cy: '12', r: '8' } },
    { type: 'path', attrs: { d: 'M12 8v5l3 2' } },
  ]);
  const calendarIcon = createSvgIcon([
    { type: 'rect', attrs: { x: '3.5', y: '5', width: '17', height: '15', rx: '2' } },
    { type: 'path', attrs: { d: 'M7 3v4M17 3v4M3.5 10h17' } },
  ]);
  const statCards = [
    createStatCard('Transcriptions', formatNumber(rewardsData.total_transcriptions), micIcon),
    createStatCard('Words', formatNumber(rewardsData.total_words), textIcon),
    createStatCard('Duration', formatDuration(rewardsData.total_duration), clockIcon),
    createStatCard('Active Days', formatNumber(rewardsData.total_active_days), calendarIcon),
  ];
  for (const card of statCards) {
    stats.appendChild(card);
  }

  dashboard.appendChild(stats);
  dashboard.appendChild(renderHeatmapSection(dailyMap));
  dashboard.appendChild(renderDailyBarSection(dailyMap));
  dashboard.appendChild(renderLanguagesSection(dailyMap));
  container.appendChild(dashboard);
}

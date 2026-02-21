const DAY_MS = 24 * 60 * 60 * 1000;
const CALENDAR_DAYS = 30;
const BADGE_COUNT = 12;

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const FALLBACK_BADGES = [
  { id: 'first_transcription', title: 'First Words', description: 'Complete your first transcription', icon: 'mic' },
  { id: 'ten_transcriptions', title: 'Getting Warm', description: 'Complete 10 transcriptions', icon: 'mic' },
  { id: 'fifty_transcriptions', title: 'On a Roll', description: 'Complete 50 transcriptions', icon: 'mic' },
  { id: 'hundred_transcriptions', title: 'Transcription Titan', description: 'Complete 100 transcriptions', icon: 'mic' },
  { id: 'three_day_streak', title: 'Spark', description: 'Maintain a 3-day streak', icon: 'flame' },
  { id: 'seven_day_streak', title: 'Week Warrior', description: 'Maintain a 7-day streak', icon: 'flame' },
  { id: 'thirty_day_streak', title: 'Unbreakable', description: 'Maintain a 30-day streak', icon: 'flame' },
  { id: 'thousand_words', title: 'Word Smith', description: 'Transcribe 1,000 words', icon: 'book' },
  { id: 'ten_thousand_words', title: 'Lexicon Builder', description: 'Transcribe 10,000 words', icon: 'book' },
  { id: 'polyglot', title: 'Polyglot', description: 'Use 3+ languages', icon: 'globe' },
  { id: 'night_owl', title: 'Night Owl', description: 'Transcribe late at night', icon: 'moon' },
  { id: 'early_bird', title: 'Early Bird', description: 'Transcribe before sunrise', icon: 'sun' },
];

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function normalizeDate(dateLike) {
  if (!dateLike) return null;
  const parsed = new Date(dateLike);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function toLocalDateKey(dateObj) {
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

function formatDate(dateLike) {
  const parsed = normalizeDate(dateLike);
  return parsed ? DATE_FORMATTER.format(parsed) : '';
}

function clampProgress(progress) {
  if (typeof progress !== 'number' || Number.isNaN(progress)) return 0;
  return Math.max(0, Math.min(1, progress));
}

function getProgressText(progress) {
  const percent = Math.round(clampProgress(progress) * 100);
  return String(percent) + '/100';
}

function getEarnedDateText(earnedAt) {
  const formatted = formatDate(earnedAt);
  return formatted ? 'Earned: ' + formatted : 'Earned';
}

function getBadgeIcon(iconId) {
  const icons = {
    mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4zm-7 9h2a5 5 0 0 0 10 0h2a7 7 0 0 1-6 6.92V21h3v2H8v-2h3v-3.08A7 7 0 0 1 5 11z"/></svg>',
    flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.8 2.6c.2 2.7-1 4.4-2.6 6.1-1.4 1.6-2.9 3.3-2.9 5.8a3.7 3.7 0 0 0 7.4 0c0-1.7-.9-3.2-2.3-4.6 3.8 1.1 6.3 4.1 6.3 7.7A7.7 7.7 0 0 1 12 24a7.7 7.7 0 0 1-7.7-7.7c0-4.9 3-8.5 9.5-13.7z"/></svg>',
    book: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4.5A2.5 2.5 0 0 1 5.5 2H20v17.5a2.5 2.5 0 0 1-2.5 2.5H6a3 3 0 0 1 0-6h12V4H5.5a.5.5 0 0 0 0 1H16v2H5.5A2.5 2.5 0 0 1 3 4.5z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 9h-3.1a14.8 14.8 0 0 0-1.2-5A8.1 8.1 0 0 1 18.9 11zM12 4c1 1.3 1.8 3.6 2 7h-4c.2-3.4 1-5.7 2-7zm-2 9h4c-.2 3.4-1 5.7-2 7-1-1.3-1.8-3.6-2-7zM9.4 6A14.8 14.8 0 0 0 8.2 11H5.1A8.1 8.1 0 0 1 9.4 6zm-4.3 7h3.1a14.8 14.8 0 0 0 1.2 5A8.1 8.1 0 0 1 5.1 13zm9.5 5a14.8 14.8 0 0 0 1.2-5h3.1a8.1 8.1 0 0 1-4.3 5z"/></svg>',
    moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.6 2.2a9.8 9.8 0 1 0 7.2 16.5 8.7 8.7 0 1 1-7.2-16.5z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 1h2v3h-2V1zm6.4 2.3 1.4 1.4-2.1 2.1-1.4-1.4 2.1-2.1zM20 11h3v2h-3v-2zM6.7 5.3 5.3 6.7 3.2 4.6l1.4-1.4 2.1 2.1zM1 11h3v2H1v-2zm3.6 9.7-1.4-1.4 2.1-2.1 1.4 1.4-2.1 2.1zM11 20h2v3h-2v-3zm5.6-2.4 2.1 2.1-1.4 1.4-2.1-2.1 1.4-1.4zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 1h6v2H9V1zm3 4a9 9 0 1 0 9 9 9 9 0 0 0-9-9zm1 4v5.2l3.5 2.1-1 1.7L11 15V9h2z"/></svg>',
  };
  return icons[iconId] || icons.mic;
}

function buildStreakHeader(data) {
  const currentStreak = Math.max(0, Number(data.current_streak) || 0);
  const header = createEl('section', 'rewards-header');

  const iconWrap = createEl('div', currentStreak > 0 ? 'streak-icon glow' : 'streak-icon');
  iconWrap.innerHTML = getBadgeIcon('flame');
  header.appendChild(iconWrap);

  const number = createEl('div', 'streak-number', String(currentStreak));
  const label = createEl('div', 'streak-label', currentStreak === 1 ? 'day streak' : 'days streak');
  header.append(number, label);

  const stats = createEl(
    'div',
    'streak-stats',
    'Longest: ' + (Number(data.longest_streak) || 0) + ' days | Active days: ' + (Number(data.total_active_days) || 0)
  );
  header.appendChild(stats);

  if (currentStreak === 0) {
    header.appendChild(createEl('div', 'streak-empty', 'No active streak'));
  }

  return header;
}

function buildBadgeGrid(data) {
  const grid = createEl('section', 'badge-grid');
  const sourceBadges = Array.isArray(data.badges) ? data.badges.slice(0, BADGE_COUNT) : [];
  const normalized = sourceBadges.map((badge, idx) => ({ ...FALLBACK_BADGES[idx], ...badge }));

  while (normalized.length < BADGE_COUNT) {
    normalized.push({ ...FALLBACK_BADGES[normalized.length], earned: false, progress: 0, earned_at: null });
  }

  normalized.forEach((badge) => {
    const earned = Boolean(badge.earned);
    const progress = clampProgress(badge.progress);
    const card = createEl('article', earned ? 'badge-card earned' : 'badge-card locked');

    const icon = createEl('div', 'badge-icon');
    icon.innerHTML = getBadgeIcon(badge.icon);

    const title = createEl('h3', 'badge-title', badge.title || 'Achievement');
    const description = createEl('p', 'badge-description', badge.description || 'Keep going to unlock this badge.');

    const progressTrack = createEl('div', 'badge-progress');
    const progressFill = createEl('div', 'badge-progress-fill');
    progressFill.style.width = String(Math.round(progress * 100)) + '%';
    progressTrack.appendChild(progressFill);

    const statusText = earned
      ? getEarnedDateText(badge.earned_at)
      : getProgressText(progress);
    const status = createEl('div', 'badge-earned-date', statusText);

    card.append(icon, title, description, progressTrack, status);
    grid.appendChild(card);
  });

  return grid;
}

function buildStreakCalendar(data) {
  const section = createEl('section', 'streak-calendar');
  section.appendChild(createEl('h3', 'streak-calendar-title', 'Last 30 Days'));

  const activeDates = new Set(Object.keys(data.daily_log || {}));
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const points = [];
  for (let i = CALENDAR_DAYS - 1; i >= 0; i -= 1) {
    const date = new Date(today.getTime() - i * DAY_MS);
    const dateKey = toLocalDateKey(date);
    const dayIndex = CALENDAR_DAYS - i;
    points.push({
      index: dayIndex,
      active: activeDates.has(dateKey),
      today: i === 0,
    });
  }

  for (let row = 0; row < 2; row += 1) {
    const rowEl = createEl('div', 'streak-row');
    const start = row * 15;
    const end = start + 15;
    points.slice(start, end).forEach((point) => {
      const cell = createEl('div', 'streak-day-cell');
      const classes = ['streak-day'];
      if (point.active) classes.push('active');
      if (point.today) classes.push('today');
      const dot = createEl('span', classes.join(' '));

      const shouldLabel = point.index === 1 || point.index % 5 === 0 || point.index === 30;
      const label = createEl('span', 'streak-day-label', shouldLabel ? String(point.index) : '');

      cell.append(dot, label);
      rowEl.appendChild(cell);
    });
    section.appendChild(rowEl);
  }

  return section;
}

export function renderRewards(container, rewardsData) {
  if (!container) return;
  container.innerHTML = '';

  if (!rewardsData) {
    container.appendChild(
      createEl('div', 'rewards-empty-state', 'Start transcribing to earn badges and track your streaks!')
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  fragment.appendChild(buildStreakHeader(rewardsData));
  fragment.appendChild(buildBadgeGrid(rewardsData));
  fragment.appendChild(buildStreakCalendar(rewardsData));
  container.appendChild(fragment);
}

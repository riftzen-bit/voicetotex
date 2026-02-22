function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

const INTENT_CONFIG = {
  code: {
    label: 'Code',
    colorClass: 'intent-code',
    keywords: [
      'code', 'coding', 'function', 'class', 'api', 'endpoint', 'typescript', 'javascript', 'python',
      'debug', 'bug', 'refactor', 'deploy', 'backend', 'frontend', 'database', 'query', 'commit',
      'build', 'test', 'npm', 'import', 'export', 'variable', 'library', 'framework', 'server',
      'script', 'algorithm', 'logic', 'syntax', 'model', 'regex', 'auth', 'hook', 'state', 'component',
      'mã', 'lap trinh', 'lập trình', 'codebase',
    ],
    patterns: [
      /\bconst\b|\blet\b|\bvar\b|=>|\{\s*\}/i,
      /\bif\s*\(|\bfor\s*\(|\bwhile\s*\(|\breturn\b/i,
      /\btry\b|\bcatch\b|\basync\b|\bawait\b/i,
    ],
  },
  design: {
    label: 'Design',
    colorClass: 'intent-design',
    keywords: [
      'design', 'ui', 'ux', 'layout', 'color', 'palette', 'typography', 'spacing', 'button', 'screen',
      'wireframe', 'figma', 'prototype', 'visual', 'animation', 'icon', 'theme', 'contrast', 'style',
      'brand', 'hero', 'landing', 'responsive', 'grid', 'card', 'flow', 'shadow', 'hover', 'font',
      'interface', 'giao dien', 'giao diện', 'thiết kế', 'thiet ke',
    ],
    patterns: [
      /\bfont\b|\bpadding\b|\bmargin\b|\bshadow\b|\bborder\b/i,
      /\bmobile\b|\bdesktop\b|\bbreakpoint\b|\bresponsive\b/i,
      /\bpalette\b|\btypography\b|\bvisual\b/i,
    ],
  },
  other: {
    label: 'General',
    colorClass: 'intent-other',
    keywords: [],
    patterns: [],
  },
};

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenize(input) {
  return input.split(/[^a-z0-9]+/).filter(Boolean);
}

function analyzeEntry(text) {
  const raw = String(text || '').trim();
  const normalized = normalizeText(raw);

  if (!normalized) {
    return {
      intent: 'other',
      confidence: 0,
      signals: [],
      percentages: { code: 0, design: 0, other: 100 },
    };
  }

  const tokens = new Set(tokenize(normalized));
  const scores = { code: 0, design: 0, other: 1 };
  const signals = { code: [], design: [] };

  for (const intent of ['code', 'design']) {
    for (const keyword of INTENT_CONFIG[intent].keywords) {
      if (keyword.includes(' ')) {
        if (normalized.includes(keyword)) {
          scores[intent] += 2;
          if (signals[intent].length < 4) signals[intent].push(keyword);
        }
      } else if (tokens.has(keyword)) {
        scores[intent] += 2;
        if (signals[intent].length < 4) signals[intent].push(keyword);
      }
    }
    for (const pattern of INTENT_CONFIG[intent].patterns) {
      if (pattern.test(raw)) scores[intent] += 3;
    }
  }

  const maxPair = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let intent = maxPair[0][0];
  const top = maxPair[0][1];
  const second = maxPair[1][1];
  if (top - second <= 1) intent = 'other';

  const total = scores.code + scores.design + scores.other;
  const percentages = {
    code: Math.round((scores.code / total) * 100),
    design: Math.round((scores.design / total) * 100),
    other: Math.round((scores.other / total) * 100),
  };

  const confidence = percentages[intent] || 0;
  return { intent, confidence, signals: signals[intent] || [], percentages };
}

function summarize(entries) {
  const items = entries.map((entry) => {
    const result = analyzeEntry(entry.text);
    return { ...entry, ...result };
  });

  const counts = { code: 0, design: 0, other: 0 };
  let confidenceSum = 0;
  for (const item of items) {
    counts[item.intent] += 1;
    confidenceSum += item.confidence;
  }

  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || ['other', 0];
  return {
    items,
    total: items.length,
    counts,
    dominant: dominant[0],
    avgConfidence: items.length > 0 ? Math.round(confidenceSum / items.length) : 0,
  };
}

function createMetricCard(label, value) {
  const card = createEl('article', 'analysis-metric-card');
  card.append(createEl('div', 'analysis-metric-value', String(value)), createEl('div', 'analysis-metric-label', label));
  return card;
}

function createIntentPill(intent) {
  return createEl('span', 'analysis-intent-pill ' + INTENT_CONFIG[intent].colorClass, INTENT_CONFIG[intent].label);
}

function createColumn(label, value, intentClass) {
  const col = createEl('div', 'analysis-col');
  const valueEl = createEl('div', 'analysis-col-value', value + '%');
  const track = createEl('div', 'analysis-col-track');
  const bar = createEl('div', 'analysis-col-bar ' + intentClass);
  bar.style.height = Math.max(6, value) + '%';
  const nameEl = createEl('div', 'analysis-col-name', label);
  track.appendChild(bar);
  col.append(valueEl, track, nameEl);
  return col;
}

function createDiagramRow(item, index) {
  const row = createEl('article', 'analysis-diagram-row');
  const left = createEl('div', 'analysis-diagram-meta');
  const indexEl = createEl('div', 'analysis-row-index', '#' + String(index + 1));
  const text = createEl('p', 'analysis-row-text', item.text || '');
  const result = createEl('div', 'analysis-row-result');
  result.append(createIntentPill(item.intent), createEl('span', 'analysis-confidence', item.confidence + '%'));
  left.append(indexEl, text, result);

  const chart = createEl('div', 'analysis-diagram-columns');
  chart.append(
    createColumn('Code', item.percentages.code, 'intent-code'),
    createColumn('Design', item.percentages.design, 'intent-design'),
    createColumn('General', item.percentages.other, 'intent-other')
  );

  row.append(left, chart);
  return row;
}

export function renderAnalysis(container, entries) {
  if (!container) return;
  container.innerHTML = '';

  const data = summarize(Array.isArray(entries) ? entries : []);

  const hero = createEl('section', 'analysis-hero');
  hero.append(
    createEl('h2', 'analysis-title', 'Spoken Text Analysis Diagram'),
    createEl('p', 'analysis-subtitle', 'Column chart view for each transcript: Code vs Design vs General.')
  );
  container.appendChild(hero);

  if (data.total === 0) {
    container.appendChild(createEl('div', 'analysis-empty', 'No transcript data yet. Record a few entries and the diagram will appear automatically.'));
    return;
  }

  const metrics = createEl('section', 'analysis-metrics');
  metrics.append(
    createMetricCard('Total', data.total),
    createMetricCard('Dominant', INTENT_CONFIG[data.dominant].label),
    createMetricCard('Code', data.counts.code),
    createMetricCard('Design', data.counts.design),
    createMetricCard('General', data.counts.other),
    createMetricCard('Avg Match', data.avgConfidence + '%')
  );
  container.appendChild(metrics);

  const diagram = createEl('section', 'analysis-diagram');
  diagram.appendChild(createEl('h3', 'analysis-list-title', 'Transcript Intent Diagram'));

  const fragment = document.createDocumentFragment();
  const recent = data.items.slice(0, 16);
  for (let i = 0; i < recent.length; i += 1) {
    fragment.appendChild(createDiagramRow(recent[i], i));
  }
  diagram.appendChild(fragment);
  container.appendChild(diagram);
}

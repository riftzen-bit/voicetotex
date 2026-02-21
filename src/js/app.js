import { WebSocketClient } from './websocket.js';
import { WaveformVisualizer } from './waveform.js';
import { SoundFeedback } from './sounds.js';

/* ------------------------------------------------------------------ */
/*  State Machine                                                      */
/* ------------------------------------------------------------------ */

const STATES = ['loading', 'ready', 'recording', 'processing'];

const STATE_COLORS = {
  loading:    'rgba(255, 170, 0, 0.85)',
  ready:      'rgba(100, 200, 100, 0.85)',
  recording:  'rgba(255, 68, 68, 0.85)',
  processing: 'rgba(100, 160, 255, 0.85)',
};

const STATE_LABELS = {
  loading:    'Loading…',
  ready:      'Ready',
  recording:  'Recording',
  processing: 'Processing…',
};

let currentState = 'loading';

/* ------------------------------------------------------------------ */
/*  DOM References (populated on DOMContentLoaded)                     */
/* ------------------------------------------------------------------ */

let dom = {};
let waveform = null;
let soundFeedback = null;
let ws = null;
let hotkeyMode = 'hold';
let wsConnected = false;
let backendAuthToken = '';
let configLanguage = 'auto';

function setTrackMeter(el, value) {
  if (!el) return;
  const pct = Math.max(2, Math.min(100, Number(value) || 0));
  el.style.width = `${pct}%`;
}

/* ------------------------------------------------------------------ */
/*  setState                                                           */
/* ------------------------------------------------------------------ */

function setState(newState) {
  if (!STATES.includes(newState)) return;
  const prevState = currentState;
  currentState = newState;
  document.body.dataset.state = newState;

  // Status indicator
  if (dom.stateDot) dom.stateDot.style.backgroundColor = STATE_COLORS[newState];
  if (dom.stateLabel) dom.stateLabel.textContent = STATE_LABELS[newState];
  if (dom.studioState) dom.studioState.textContent = STATE_LABELS[newState];

  // Mic button appearance
  if (dom.micBtn) {
    dom.micBtn.classList.toggle('recording', newState === 'recording');
    dom.micBtn.disabled = (newState === 'loading' || newState === 'processing');
  }

  // Waveform control
  if (waveform) {
    if (newState === 'recording') {
      waveform.setColor(STATE_COLORS.recording);
      waveform.start();
    } else if (newState === 'ready') {
      waveform.setColor(STATE_COLORS.ready);
      waveform.start();
    } else if (newState === 'processing') {
      waveform.setColor(STATE_COLORS.processing);
      waveform.start();
    } else {
      waveform.stop();
    }
  }

  if (newState === 'recording') {
    setTrackMeter(dom.trackMeterProcessing, 26);
  } else if (newState === 'processing') {
    setTrackMeter(dom.trackMeterProcessing, 84);
  } else if (newState === 'ready') {
    setTrackMeter(dom.trackMeterProcessing, 6);
  }

  // Sound feedback
  if (newState === 'recording' && soundFeedback) {
    soundFeedback.playRecordingStart();
  } else if (newState === 'processing' && prevState === 'recording' && soundFeedback) {
    soundFeedback.playRecordingStop();
  }

  // Loading overlay
  if (dom.loadingOverlay) {
    dom.loadingOverlay.classList.toggle('visible', newState === 'loading');
  }

  // Forward state to main process for tray/overlay
  if (window.api && window.api.notifyMainState) {
    window.api.notifyMainState(newState);
  }
}

/* ------------------------------------------------------------------ */
/*  Transcript                                                         */
/* ------------------------------------------------------------------ */

const MAX_VISIBLE_ITEMS = 100;

function updateTranscriptCount() {
  if (!dom.transcriptList) return;
  const items = dom.transcriptList.querySelectorAll('.transcript-item');
  const count = items.length;
  if (dom.transcriptCount) {
    dom.transcriptCount.textContent = count > 0 ? count : '';
  }
  if (dom.wordCount) {
    if (count > 0) {
      let totalWords = 0;
      for (const item of items) {
        const textEl = item.querySelector('.transcript-text');
        if (textEl) {
          const words = textEl.textContent.trim().split(/\s+/).filter(w => w.length > 0);
          totalWords += words.length;
        }
      }
      dom.wordCount.textContent = `${totalWords} words`;
    } else {
      dom.wordCount.textContent = '';
    }
  }
}

function addTranscriptItem(msg) {
  const list = dom.transcriptList;
  if (!list) return;

  // Remove empty-state placeholder
  const empty = list.querySelector('.transcript-empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'transcript-item';
  item.setAttribute('role', 'listitem');
  item.dataset.segments = JSON.stringify(msg.segments || []);

  const meta = document.createElement('div');
  meta.className = 'transcript-meta';

  // Timestamp
  const time = document.createElement('span');
  time.className = 'transcript-time';
  const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
  time.textContent = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

  // Text
  const text = document.createElement('span');
  text.className = 'transcript-text';
  text.setAttribute('contenteditable', 'plaintext-only');
  text.setAttribute('spellcheck', 'false');
  text.textContent = msg.text || '';

  let savedText = msg.text || '';
  text.addEventListener('focus', () => {
    savedText = text.textContent;
    item.classList.add('editing');
  });
  text.addEventListener('blur', () => {
    item.classList.remove('editing');
    const newText = text.textContent.trim();
    if (newText && newText !== savedText && ws && msg.id) {
      savedText = newText;
      ws.send('update_history_entry', { id: msg.id, text: newText });
    } else if (!newText) {
      text.textContent = savedText;
    }
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      text.blur();
    }
    if (e.key === 'Escape') {
      text.textContent = savedText;
      text.blur();
    }
  });

  // Language badge
  const lang = document.createElement('span');
  lang.className = 'transcript-lang badge';
  lang.textContent = (msg.language || '').toUpperCase();

  const duration = document.createElement('span');
  duration.className = 'transcript-duration';
  if (msg.duration != null && msg.duration > 0) {
    const secs = Math.round(msg.duration);
    duration.textContent = secs >= 60
      ? `${Math.floor(secs / 60)}m ${secs % 60}s`
      : `${secs}s`;
  }

  const actions = document.createElement('div');
  actions.className = 'transcript-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'transcript-action-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(text.textContent || '').then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
    });
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'transcript-action-btn transcript-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', () => {
    if (ws && msg.id) {
      ws.send('delete_history_entry', { id: msg.id });
      item.remove();
      if (dom.transcriptList && dom.transcriptList.children.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'transcript-empty';
        empty.setAttribute('role', 'status');
        empty.innerHTML = '<svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg><span class="empty-title">No transcripts yet</span><span class="empty-subtitle">Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to start recording</span>';
        dom.transcriptList.appendChild(empty);
      }
    }
  });

  actions.appendChild(copyBtn);
  actions.appendChild(deleteBtn);

  meta.appendChild(time);
  meta.appendChild(duration);
  meta.appendChild(lang);

  item.appendChild(meta);
  item.appendChild(text);
  item.appendChild(actions);

  // Prepend (newest first)
  list.prepend(item);

  while (list.children.length > MAX_VISIBLE_ITEMS) {
    list.removeChild(list.lastElementChild);
  }

  updateTranscriptPreview(msg);
  updateTranscriptCount();
}

/* ------------------------------------------------------------------ */
/*  Toast Notifications                                                */
/* ------------------------------------------------------------------ */

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger reflow so CSS transition kicks in
  toast.offsetHeight; // eslint-disable-line no-unused-expressions
  toast.classList.add('visible');

  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    // Fallback removal if no transition fires
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 500);
  }, 4000);
}

/* ------------------------------------------------------------------ */
/*  Confirm Dialog                                                     */
/* ------------------------------------------------------------------ */

function showConfirm(message, onConfirm) {
  const existing = document.querySelector('.confirm-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'confirm-dialog';

  const msg = document.createElement('div');
  msg.className = 'confirm-message';
  msg.textContent = message;

  const btnRow = document.createElement('div');
  btnRow.className = 'confirm-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'confirm-btn confirm-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const okBtn = document.createElement('button');
  okBtn.className = 'confirm-btn confirm-ok';
  okBtn.textContent = 'Confirm';
  okBtn.addEventListener('click', () => {
    overlay.remove();
    onConfirm();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(okBtn);
  dialog.appendChild(msg);
  dialog.appendChild(btnRow);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
}

/* ------------------------------------------------------------------ */
/*  Loading Progress                                                   */
/* ------------------------------------------------------------------ */

function updateLoadingProgress(stage, percent) {
  if (dom.loadingText) {
    dom.loadingText.textContent = stage || 'Loading model…';
  }
  if (dom.progressFill) {
    dom.progressFill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
  }
}

/* ------------------------------------------------------------------ */
/*  Config UI                                                          */
/* ------------------------------------------------------------------ */

function updateConfigUI(config) {
  if (!config) return;

  if (config.model && dom.settingModel) {
    dom.settingModel.value = config.model;
  }
  if (config.language && dom.settingLanguage) {
    dom.settingLanguage.value = config.language;
    configLanguage = config.language;
  }
  if (config.output_mode) {
    const radio = document.querySelector(`input[name="output-mode"][value="${config.output_mode}"]`);
    if (radio) radio.checked = true;
  }
  if (config.hotkey_mode) {
    hotkeyMode = config.hotkey_mode;
    const radio = document.querySelector(`input[name="hotkey-mode"][value="${config.hotkey_mode}"]`);
    if (radio) radio.checked = true;
    if (dom.studioHotkeyMode) {
      dom.studioHotkeyMode.textContent = config.hotkey_mode.charAt(0).toUpperCase() + config.hotkey_mode.slice(1);
    }
  }
  if (config.vad_threshold != null && dom.settingVad) {
    dom.settingVad.value = Math.round(config.vad_threshold * 100);
    if (dom.vadValue) dom.vadValue.textContent = config.vad_threshold;
  }
  if (config.noise_reduction != null && dom.settingNoiseReduction) {
    dom.settingNoiseReduction.checked = config.noise_reduction;
  }
  if (config.beam_size != null && dom.settingBeam) {
    dom.settingBeam.value = config.beam_size;
    if (dom.beamValue) dom.beamValue.textContent = config.beam_size;
  }

  if (config.hotkey) {
    const display = formatHotkeyDisplay(config.hotkey);
    if (dom.hotkeyRecorderKeys) dom.hotkeyRecorderKeys.textContent = display;
    if (dom.hotkeyHint) dom.hotkeyHint.textContent = display;
  }

  if (config.available_models && Array.isArray(config.available_models) && dom.settingModel) {
    const currentModel = dom.settingModel.value;
    dom.settingModel.innerHTML = '';
    for (const m of config.available_models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = `${m.name} (${m.size})`;
      dom.settingModel.appendChild(opt);
    }
    if (config.model) dom.settingModel.value = config.model;
    else if (currentModel) dom.settingModel.value = currentModel;
  }

  if (config.initial_prompt != null && dom.settingInitialPrompt) {
    dom.settingInitialPrompt.value = config.initial_prompt;
  }

  if (config.audio_device != null && dom.settingDevice) {
    dom.settingDevice.value = config.audio_device;
  }

  // Update header badges
  if (config.language && dom.langBadge) {
    dom.langBadge.textContent = config.language === 'auto' ? 'AUTO' : config.language.toUpperCase();
  }
  if (config.model && dom.modelBadge) {
    dom.modelBadge.textContent = config.model;
  }
}

function updateDeviceSelector(devices) {
  if (!dom.settingDevice || !Array.isArray(devices)) return;

  // Preserve current selection
  const current = dom.settingDevice.value;

  // Clear all but first (default) option
  while (dom.settingDevice.options.length > 1) {
    dom.settingDevice.remove(1);
  }

  for (const dev of devices) {
    const opt = document.createElement('option');
    opt.value = dev.id || dev.name;
    opt.textContent = dev.name;
    dom.settingDevice.appendChild(opt);
  }

  // Restore selection if still available
  if (current) dom.settingDevice.value = current;
}

function renderHistory(entries) {
  if (!dom.transcriptList || !Array.isArray(entries)) return;

  // Clear existing items
  dom.transcriptList.innerHTML = '';

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'transcript-empty';
    empty.setAttribute('role', 'status');
    empty.innerHTML = '<svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z"/><path d="M19 11a7 7 0 0 1-14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg><span class="empty-title">No transcripts yet</span><span class="empty-subtitle">Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to start recording</span>';
    dom.transcriptList.appendChild(empty);
    updateTranscriptCount();
    return;
  }

  for (const entry of entries) {
    addTranscriptItem(entry);
  }

  updateTranscriptCount();

  if (entries.length > 0) {
    updateTranscriptPreview(entries[0]);
  } else if (dom.transcriptPreview) {
    dom.transcriptPreview.innerHTML = '<div class="transcript-preview-empty">Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd> to start recording</div>';
  }
}

/* ------------------------------------------------------------------ */
/*  Tab Switching                                                      */
/* ------------------------------------------------------------------ */

function switchTab(tabName) {
  dom.tabBtns.forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  dom.tabPanels.forEach(panel => {
    panel.classList.toggle('active', panel.id === 'tab-' + tabName);
  });
}

/* ------------------------------------------------------------------ */
/*  Transcript Preview (Studio Tab)                                    */
/* ------------------------------------------------------------------ */

function updateTranscriptPreview(msg) {
  if (!dom.transcriptPreview) return;
  dom.transcriptPreview.innerHTML = '';

  const text = document.createElement('div');
  text.className = 'transcript-preview-text';
  text.textContent = msg.text || '';

  const meta = document.createElement('div');
  meta.className = 'transcript-preview-meta';
  const ts = msg.timestamp ? new Date(msg.timestamp) : new Date();
  const lang = (msg.language || '').toUpperCase();
  meta.textContent = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) + ' \u00b7 ' + lang;

  dom.transcriptPreview.appendChild(text);
  dom.transcriptPreview.appendChild(meta);
}

/* ------------------------------------------------------------------ */
/*  Settings Change Handlers                                           */
/* ------------------------------------------------------------------ */

function setupSettingsListeners() {
  // Dropdowns
  if (dom.settingModel) {
    dom.settingModel.addEventListener('change', () => {
      if (ws) ws.send('switch_model', { model: dom.settingModel.value });
      if (dom.modelBadge) dom.modelBadge.textContent = dom.settingModel.value;
    });
  }

  const configSelects = [
    { el: dom.settingLanguage, key: 'language' },
    { el: dom.settingDevice,   key: 'audio_device' },
  ];
  for (const { el, key } of configSelects) {
    if (el) {
      el.addEventListener('change', () => {
        if (ws) ws.send('set_config', { key, value: el.value });
        if (key === 'language') {
          configLanguage = el.value;
          if (dom.langBadge) {
            dom.langBadge.textContent = el.value === 'auto' ? 'AUTO' : el.value.toUpperCase();
          }
        }
      });
    }
  }

  // Radio groups
  for (const name of ['output-mode', 'hotkey-mode']) {
    const radios = document.querySelectorAll(`input[name="${name}"]`);
    const key = name.replace('-', '_');
    for (const radio of radios) {
      radio.addEventListener('change', () => {
        if (radio.checked && ws) {
          ws.send('set_config', { key, value: radio.value });
          if (key === 'hotkey_mode') {
            hotkeyMode = radio.value;
            if (dom.studioHotkeyMode) {
              dom.studioHotkeyMode.textContent = radio.value.charAt(0).toUpperCase() + radio.value.slice(1);
            }
          }
        }
      });
    }
  }

  // Range sliders
  if (dom.settingVad) {
    dom.settingVad.addEventListener('input', () => {
      if (dom.vadValue) dom.vadValue.textContent = (Number(dom.settingVad.value) / 100).toFixed(1);
    });
    dom.settingVad.addEventListener('change', () => {
      if (ws) ws.send('set_config', { key: 'vad_threshold', value: Number(dom.settingVad.value) / 100 });
    });
  }

  if (dom.settingBeam) {
    dom.settingBeam.addEventListener('input', () => {
      if (dom.beamValue) dom.beamValue.textContent = dom.settingBeam.value;
    });
    dom.settingBeam.addEventListener('change', () => {
      if (ws) ws.send('set_config', { key: 'beam_size', value: Number(dom.settingBeam.value) });
    });
  }

  // Checkbox
  if (dom.settingNoiseReduction) {
    dom.settingNoiseReduction.addEventListener('change', () => {
      if (ws) ws.send('set_config', { key: 'noise_reduction', value: dom.settingNoiseReduction.checked });
    });
  }

  // Clear history (both Transcripts toolbar and Settings page buttons)
  const clearHistoryHandler = () => {
    showConfirm('Clear all transcription history?', () => {
      if (ws) ws.send('clear_history');
      renderHistory([]);
    });
  };
  if (dom.btnClearHistory) {
    dom.btnClearHistory.addEventListener('click', clearHistoryHandler);
  }
  if (dom.btnClearHistorySettings) {
    dom.btnClearHistorySettings.addEventListener('click', clearHistoryHandler);
  }

  // Hotkey recorder
  if (dom.settingInitialPrompt) {
    let promptDebounce = null;
    dom.settingInitialPrompt.addEventListener('input', () => {
      clearTimeout(promptDebounce);
      promptDebounce = setTimeout(() => {
        if (ws) ws.send('set_config', { key: 'initial_prompt', value: dom.settingInitialPrompt.value });
      }, 600);
    });
  }

  if (dom.transcriptSearch) {
    dom.transcriptSearch.addEventListener('input', () => {
      filterTranscripts(dom.transcriptSearch.value);
    });
  }

  if (dom.hotkeyRecorder) {
    setupHotkeyRecorder();
  }
}

/* ------------------------------------------------------------------ */
/*  Hotkey Recorder                                                    */
/* ------------------------------------------------------------------ */

const KEY_DISPLAY_MAP = {
  Control: 'Ctrl', Meta: 'Super', ' ': 'Space',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};

function keyToDisplay(key) {
  if (KEY_DISPLAY_MAP[key]) return KEY_DISPLAY_MAP[key];
  if (key.length === 1) return key.toUpperCase();
  return key;
}

function keyToBackend(key) {
  const map = {
    Control: 'ctrl', Shift: 'shift', Alt: 'alt', Meta: 'super', ' ': 'space',
  };
  if (map[key]) return map[key];
  if (key.length === 1) return key.toLowerCase();
  return key.toLowerCase();
}

function formatHotkeyDisplay(comboString) {
  return comboString.split('+').map(t => {
    const lower = t.trim().toLowerCase();
    const display = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', super: 'Super', space: 'Space' };
    return display[lower] || t.charAt(0).toUpperCase() + t.slice(1);
  }).join('+');
}

function setupHotkeyRecorder() {
  const recorder = dom.hotkeyRecorder;
  const keysDisplay = dom.hotkeyRecorderKeys;
  let listening = false;
  let heldKeys = [];

  function stopListening() {
    listening = false;
    recorder.classList.remove('listening');
    if (dom.hotkeyRecorderKeys) {
      const hint = recorder.querySelector('.hotkey-recorder-hint');
      if (hint) hint.textContent = 'Click to change';
    }
  }

  function applyCombo(keys) {
    const backendCombo = keys.map(keyToBackend).join('+');
    const displayCombo = keys.map(keyToDisplay).join('+');

    keysDisplay.textContent = displayCombo;
    if (dom.hotkeyHint) dom.hotkeyHint.textContent = displayCombo;
    if (ws) ws.send('set_config', { key: 'hotkey', value: backendCombo });
  }

  recorder.addEventListener('click', () => {
    if (listening) return;
    listening = true;
    heldKeys = [];
    recorder.classList.add('listening');
    keysDisplay.textContent = 'Press keys...';
    const hint = recorder.querySelector('.hotkey-recorder-hint');
    if (hint) hint.textContent = 'Esc to cancel';
    recorder.focus();
  });

  recorder.addEventListener('keydown', (e) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      stopListening();
      return;
    }

    if (!heldKeys.includes(e.key)) {
      heldKeys.push(e.key);
    }
    keysDisplay.textContent = heldKeys.map(keyToDisplay).join('+');
  });

  recorder.addEventListener('keyup', (e) => {
    if (!listening) return;
    e.preventDefault();
    e.stopPropagation();

    if (heldKeys.length > 0) {
      applyCombo(heldKeys);
      stopListening();
    }
  });

  recorder.addEventListener('blur', () => {
    if (listening) stopListening();
  });
}

/* ------------------------------------------------------------------ */
/*  Connection Indicator                                               */
/* ------------------------------------------------------------------ */

function updateConnectionIndicator(connected) {
  wsConnected = connected;
  if (dom.connectionDot) {
    dom.connectionDot.classList.toggle('connected', connected);
    dom.connectionDot.classList.toggle('disconnected', !connected);
  }
  if (dom.connectionLabel) {
    dom.connectionLabel.textContent = connected ? 'Connected' : 'Disconnected';
  }
  if (dom.studioConnection) {
    dom.studioConnection.textContent = connected ? 'Online' : 'Offline';
  }
}

/* ------------------------------------------------------------------ */
/*  Transcript Search                                                  */
/* ------------------------------------------------------------------ */

function filterTranscripts(query) {
  if (!dom.transcriptList) return;
  const items = dom.transcriptList.querySelectorAll('.transcript-item');
  const lower = (query || '').toLowerCase();

  for (const item of items) {
    const textEl = item.querySelector('.transcript-text');
    const text = textEl ? textEl.textContent.toLowerCase() : '';
    item.style.display = (!lower || text.includes(lower)) ? '' : 'none';
  }
}

/* ------------------------------------------------------------------ */
/*  WebSocket Wiring                                                   */
/* ------------------------------------------------------------------ */

function connectWebSocket(port, authToken = '') {
  if (ws) ws.disconnect();

  ws = new WebSocketClient(`ws://127.0.0.1:${port}`, authToken);

  ws.on('status', (msg) => {
    if (msg.state) setState(msg.state);
  });

  ws.on('audio_level', (msg) => {
    if (waveform && typeof msg.level === 'number') {
      waveform.pushLevel(msg.level);
      setTrackMeter(dom.trackMeterInput, Math.min(100, Math.round(msg.level * 220)));
    }
  });

  ws.on('transcript', (msg) => {
    addTranscriptItem(msg);
    if (soundFeedback) soundFeedback.playTranscriptDone();
    setTrackMeter(dom.trackMeterOutput, 100);
    setTimeout(() => setTrackMeter(dom.trackMeterOutput, 34), 320);

    // Show detected language in header badge when config is auto
    if (configLanguage === 'auto' && msg.language && dom.langBadge) {
      dom.langBadge.textContent = `AUTO \u00b7 ${msg.language.toUpperCase()}`;
    }
  });

  ws.on('model_progress', (msg) => {
    updateLoadingProgress(msg.stage, msg.percent);
  });

  ws.on('error', (msg) => {
    showToast(msg.message || 'An error occurred', 'error');
  });

  ws.on('config', (msg) => {
    updateConfigUI(msg.data);
  });

  ws.on('history', (msg) => {
    renderHistory(msg.entries);
  });

  ws.on('devices', (msg) => {
    updateDeviceSelector(msg.list);
  });

  // Request initial data once connected
  ws.on('open', () => {
    updateConnectionIndicator(true);
    ws.send('get_config');
    ws.send('get_history');
    ws.send('get_devices');
  });

  ws.on('close', () => {
    updateConnectionIndicator(false);
  });

  ws.connect();
}

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function exportTranscripts(format) {
  if (!dom.transcriptList) return;
  const items = dom.transcriptList.querySelectorAll('.transcript-item');
  if (items.length === 0) {
    showToast('No transcripts to export', 'info');
    return;
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  let content = '';
  let filename = '';

  if (format === 'txt') {
    const lines = [];
    for (const item of items) {
      const time = item.querySelector('.transcript-time');
      const text = item.querySelector('.transcript-text');
      const lang = item.querySelector('.transcript-lang');
      lines.push(`[${time ? time.textContent : ''}] [${lang ? lang.textContent : ''}] ${text ? text.textContent : ''}`);
    }
    content = lines.join('\n\n');
    filename = `transcripts-${dateStr}.txt`;
  } else if (format === 'json') {
    const entries = [];
    for (const item of items) {
      const time = item.querySelector('.transcript-time');
      const text = item.querySelector('.transcript-text');
      const lang = item.querySelector('.transcript-lang');
      const dur = item.querySelector('.transcript-duration');
      let segments = [];
      try { segments = JSON.parse(item.dataset.segments || '[]'); } catch {}
      entries.push({
        time: time ? time.textContent : '',
        text: text ? text.textContent : '',
        language: lang ? lang.textContent : '',
        duration: dur ? dur.textContent : '',
        segments,
      });
    }
    content = JSON.stringify(entries, null, 2);
    filename = `transcripts-${dateStr}.json`;
  } else if (format === 'srt') {
    let counter = 1;
    const blocks = [];
    for (const item of items) {
      let segments = [];
      try { segments = JSON.parse(item.dataset.segments || '[]'); } catch {}
      if (segments.length > 0) {
        for (const seg of segments) {
          blocks.push(`${counter}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}`);
          counter++;
        }
      } else {
        const text = item.querySelector('.transcript-text');
        blocks.push(`${counter}\n00:00:00,000 --> 00:00:00,000\n${text ? text.textContent : ''}`);
        counter++;
      }
    }
    content = blocks.join('\n\n');
    filename = `transcripts-${dateStr}.srt`;
  } else if (format === 'vtt') {
    const blocks = ['WEBVTT\n'];
    for (const item of items) {
      let segments = [];
      try { segments = JSON.parse(item.dataset.segments || '[]'); } catch {}
      if (segments.length > 0) {
        for (const seg of segments) {
          blocks.push(`${formatVttTime(seg.start)} --> ${formatVttTime(seg.end)}\n${seg.text}`);
        }
      } else {
        const text = item.querySelector('.transcript-text');
        blocks.push(`00:00:00.000 --> 00:00:00.000\n${text ? text.textContent : ''}`);
      }
    }
    content = blocks.join('\n\n');
    filename = `transcripts-${dateStr}.vtt`;
  }

  if (window.api && window.api.exportFile) {
    window.api.exportFile(content, filename).then((ok) => {
      if (ok) showToast(`Exported as ${format.toUpperCase()}`, 'info');
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Initialization                                                     */
/* ------------------------------------------------------------------ */

document.addEventListener('DOMContentLoaded', () => {
  // Gather DOM references
  dom = {
    micBtn:               document.getElementById('mic-btn'),
    waveformCanvas:       document.getElementById('waveform'),
    transcriptList:       document.getElementById('transcript-list'),
    stateDot:             document.querySelector('.state-dot'),
    stateLabel:           document.querySelector('.state-label'),
    langBadge:            document.getElementById('lang-badge'),
    modelBadge:           document.getElementById('model-badge'),
    tabBtns:              document.querySelectorAll('.tab-btn'),
    tabPanels:            document.querySelectorAll('.tab-panel'),
    transcriptPreview:    document.getElementById('transcript-preview'),
    loadingOverlay:       document.getElementById('loading-overlay'),
    loadingText:          document.querySelector('.loading-text'),
    progressFill:         document.getElementById('progress-fill'),
    btnMinimize:          document.getElementById('btn-minimize'),
    btnClose:             document.getElementById('btn-close'),
    settingModel:         document.getElementById('setting-model'),
    settingLanguage:      document.getElementById('setting-language'),
    settingDevice:        document.getElementById('setting-device'),
    settingVad:           document.getElementById('setting-vad'),
    vadValue:             document.getElementById('vad-value'),
    settingNoiseReduction: document.getElementById('setting-noise-reduction'),
    settingBeam:          document.getElementById('setting-beam'),
    beamValue:            document.getElementById('beam-value'),
    btnClearHistory:      document.getElementById('btn-clear-history'),
    hotkeyRecorder:       document.getElementById('hotkey-recorder'),
    hotkeyRecorderKeys:   document.getElementById('hotkey-recorder-keys'),
    hotkeyHint:           document.querySelector('.hotkey-hint'),
    settingInitialPrompt: document.getElementById('setting-initial-prompt'),
    connectionDot:        document.getElementById('connection-dot'),
    connectionLabel:      document.getElementById('connection-label'),
    transcriptSearch:     document.getElementById('transcript-search'),
    btnExport:            document.getElementById('btn-export'),
    exportDropdown:       document.getElementById('export-dropdown'),
    exportMenu:           document.getElementById('export-menu'),
    crashOverlay:         document.getElementById('crash-overlay'),
    crashMessage:         document.getElementById('crash-message'),
    btnCrashRetry:        document.getElementById('btn-crash-retry'),
    studioState:          document.getElementById('studio-state'),
    studioConnection:     document.getElementById('studio-connection'),
    studioHotkeyMode:     document.getElementById('studio-hotkey-mode'),
    trackMeterInput:      document.getElementById('track-meter-input'),
    trackMeterProcessing: document.getElementById('track-meter-processing'),
    trackMeterOutput:     document.getElementById('track-meter-output'),
    transcriptCount:      document.getElementById('transcript-count'),
    wordCount:            document.getElementById('word-count'),
    btnClearHistorySettings: document.getElementById('btn-clear-history-settings'),
    btnShortcuts:         document.getElementById('btn-shortcuts'),
    shortcutsModal:       document.getElementById('shortcuts-modal'),
    btnCloseShortcuts:    document.getElementById('btn-close-shortcuts'),
    aboutRepoLink:        document.getElementById('about-repo-link'),
  };

  // Initialize waveform
  if (dom.waveformCanvas) {
    waveform = new WaveformVisualizer(dom.waveformCanvas);
  }

  // Initialize sound feedback
  soundFeedback = new SoundFeedback();

  // Warm up AudioContext on first user interaction (for hotkey users who
  // never click the mic button — Chromium requires a user gesture to unlock).
  const unlockAudio = () => {
    if (soundFeedback) soundFeedback.warmUp();
    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  };
  document.addEventListener('click', unlockAudio, { once: false });
  document.addEventListener('keydown', unlockAudio, { once: false });

  // Set initial state
  setState('loading');
  setTrackMeter(dom.trackMeterInput, 4);
  setTrackMeter(dom.trackMeterProcessing, 6);
  setTrackMeter(dom.trackMeterOutput, 8);

  // ---- Titlebar controls ----
  if (dom.btnMinimize) {
    dom.btnMinimize.addEventListener('click', () => window.api.minimizeWindow());
  }
  if (dom.btnClose) {
    dom.btnClose.addEventListener('click', () => window.api.closeWindow());
  }

  // ---- About Link ----
  if (dom.aboutRepoLink) {
    dom.aboutRepoLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.open('https://github.com/riftzen-bit/voicetotex', '_blank');
    });
  }

  // ---- Shortcuts modal ----
  function toggleShortcutsModal(show) {
    if (dom.shortcutsModal) {
      dom.shortcutsModal.classList.toggle('visible', show);
    }
  }
  if (dom.btnShortcuts) {
    dom.btnShortcuts.addEventListener('click', () => toggleShortcutsModal(true));
  }
  if (dom.btnCloseShortcuts) {
    dom.btnCloseShortcuts.addEventListener('click', () => toggleShortcutsModal(false));
  }
  if (dom.shortcutsModal) {
    dom.shortcutsModal.addEventListener('click', (e) => {
      if (e.target === dom.shortcutsModal) toggleShortcutsModal(false);
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '/') {
      e.preventDefault();
      const isVisible = dom.shortcutsModal && dom.shortcutsModal.classList.contains('visible');
      toggleShortcutsModal(!isVisible);
    }
    if (e.key === 'Escape' && dom.shortcutsModal && dom.shortcutsModal.classList.contains('visible')) {
      toggleShortcutsModal(false);
    }
  });

  dom.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ---- Mic button (supports both hold and toggle modes) ----
  if (dom.micBtn) {
    let micHolding = false;

    dom.micBtn.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (soundFeedback) soundFeedback.warmUp();
      if (hotkeyMode === 'hold' && currentState === 'ready') {
        micHolding = true;
        if (ws) ws.send('start_recording');
      }
    });

    const endHold = () => {
      if (micHolding && hotkeyMode === 'hold' && currentState === 'recording') {
        if (ws) ws.send('stop_recording');
      }
      micHolding = false;
    };

    dom.micBtn.addEventListener('mouseup', endHold);
    dom.micBtn.addEventListener('mouseleave', endHold);

    dom.micBtn.addEventListener('click', () => {
      if (soundFeedback) soundFeedback.warmUp();
      if (hotkeyMode === 'hold') return;
      if (currentState === 'ready') {
        if (ws) ws.send('start_recording');
      } else if (currentState === 'recording') {
        if (ws) ws.send('stop_recording');
      }
    });

    dom.micBtn.addEventListener('touchstart', (e) => {
      if (soundFeedback) soundFeedback.warmUp();
      if (hotkeyMode === 'hold' && currentState === 'ready') {
        e.preventDefault();
        micHolding = true;
        if (ws) ws.send('start_recording');
      }
    }, { passive: false });

    dom.micBtn.addEventListener('touchend', () => {
      endHold();
    });
  }

  // ---- Settings change listeners ----
  setupSettingsListeners();

  if (dom.btnExport) {
    dom.btnExport.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = document.getElementById('export-menu');
      if (menu) menu.classList.toggle('visible');
    });
  }

  document.addEventListener('click', () => {
    const menu = document.getElementById('export-menu');
    if (menu) menu.classList.remove('visible');
  });

  const exportMenu = document.getElementById('export-menu');
  if (exportMenu) {
    exportMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-format]');
      if (!btn) return;
      e.stopPropagation();
      exportMenu.classList.remove('visible');
      exportTranscripts(btn.dataset.format);
    });
  }

  // ---- Backend status from Electron main process ----
  if (window.api && window.api.onBackendStatus) {
    window.api.onBackendStatus((data) => {
      if (data && data.port) {
        backendAuthToken = data.authToken || '';
        if (dom.crashOverlay) dom.crashOverlay.classList.remove('visible');
        connectWebSocket(data.port, backendAuthToken);
      } else if (data && data.status === 'crashed') {
        if (dom.crashOverlay) {
          if (dom.crashMessage) dom.crashMessage.textContent = data.message || 'The transcription engine stopped unexpectedly.';
          dom.crashOverlay.classList.add('visible');
        }
      } else if (data && data.status === 'error') {
        showToast(data.message || 'Backend error', 'error');
      } else if (data && data.status === 'restarting') {
        showToast(`Restarting backend (attempt ${data.attempt})...`, 'info');
      }
    });
  }

  if (dom.btnCrashRetry) {
    dom.btnCrashRetry.addEventListener('click', () => {
      if (dom.crashOverlay) dom.crashOverlay.classList.remove('visible');
      setState('loading');
      showToast('Restarting backend...', 'info');
      if (window.api && window.api.restartBackend) {
        window.api.restartBackend();
      }
    });
  }

  // ---- Tray command forwarding ----
  if (window.api && window.api.onTrayCommand) {
    window.api.onTrayCommand((action) => {
      if (!ws) return;
      if (action === 'start-recording' && currentState === 'ready') {
        ws.send('start_recording');
      } else if (action === 'stop-recording' && currentState === 'recording') {
        ws.send('stop_recording');
      }
    });
  }

  // ---- Language change from tray ----
  if (window.api && window.api.onLanguageChange) {
    window.api.onLanguageChange((lang) => {
      if (ws) ws.send('set_config', { key: 'language', value: lang });
      if (dom.langBadge) {
        dom.langBadge.textContent = lang === 'auto' ? 'AUTO' : lang.toUpperCase();
      }
      if (dom.settingLanguage) dom.settingLanguage.value = lang;
    });
  }
});

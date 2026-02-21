'use strict';

const STATE_LABELS = {
  loading: 'Loading\u2026',
  ready: 'Ready',
  recording: 'Recording',
  processing: 'Processing\u2026',
};

const dot = document.getElementById('dot');
const label = document.getElementById('label');
const pill = document.getElementById('pill');

if (window.overlayApi) {
  window.overlayApi.onStateUpdate((state) => {
    document.body.dataset.state = state;
    if (label) label.textContent = STATE_LABELS[state] || state;
  });
}

if (pill) {
  pill.addEventListener('click', () => {
    if (window.overlayApi) window.overlayApi.showMainWindow();
  });
}

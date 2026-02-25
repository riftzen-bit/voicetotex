# VoiceToTex v1.1.1 Release Notes

## Included Fixes

- Fixed backend startup failure in local/dev runs by setting up and using a project Python virtualenv (`backend/.venv`) with required dependencies.
- Improved text injection stability after recording stops (focus restore timing + modifier-key cleanup).
- Fixed long-session history growth by enforcing `max_history` trimming on add/load.
- Improved transcription recognition for AI/code/design terms using an internal vocabulary prompt bias.
- Added post-processing normalization for common technical/product names:
  - `Claude Code`
  - `OpenAI`
  - `ChatGPT`
  - `VS Code`
  - `GitHub Copilot`
  - `Node.js`
  - `Next.js`
- Fixed audio ducking behavior to keep `mute` during recording while improving automatic sound restore after processing.

## Known Issues / Next Updates

- Audio mute restore can still be affected by external audio apps creating/destroying sink inputs very quickly on some PulseAudio/PipeWire setups. Continue testing repeated hold/release cycles.
- ALSA input devices that do not support `16000 Hz` trigger fallback logs; recording still works after fallback to device default sample rate.
- First model load/download can take a long time depending on network and model cache state.
- Text injection behavior may vary by Linux desktop/compositor and target app security restrictions (Wayland/X11 differences).
- Add a user-configurable vocabulary/template UI for domain-specific terms (AI, coding, design, project names) instead of only built-in defaults.
- Add persistent diagnostic logs export in the UI for easier bug reporting.

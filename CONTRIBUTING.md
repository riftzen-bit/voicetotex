# Contributing to VoiceToTex

Thank you for your interest in contributing to VoiceToTex.

## Reporting Bugs

If you find a bug, please use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) to open an issue. Provide as much detail as possible to help reproduce the problem.

## Suggesting Features

For new feature ideas, please use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) to describe your proposal.

## Development Setup

The project primarily targets Linux. Use these steps to set up your local environment:

```bash
git clone https://github.com/riftzen-bit/voicetotex.git
cd voicetotex
bash scripts/setup.sh
bash scripts/start.sh
```

## Architecture

VoiceToTex consists of three main parts:
- Electron main process
- Python WebSocket backend
- Renderer process

These components communicate via WebSockets to handle voice processing and UI updates.

## Code Style Guidelines

### Python
- Follow existing patterns in the codebase.
- Use type hints for all function definitions.
- Ensure compatibility with the WebSocket backend.

### JavaScript
- Use vanilla JavaScript only.
- Do not use frameworks.
- Use ES modules for code organization.
- Do not use `as any` or `@ts-ignore`.

### CSS
- Use existing CSS custom properties for styling (e.g., `--bg-base`, `--accent`).
- Do not use `!important`.

## Pull Request Process

1. Fork the repository and create your branch from `main`.
2. Commit your changes with descriptive messages.
3. Test your changes manually. There is currently no automated test suite.
4. Keep pull requests focused on a single change or fix.
5. Open the pull request against the `main` branch of the original repository.

## Licensing

By contributing to VoiceToTex, you agree that your contributions will be licensed under the MIT License.

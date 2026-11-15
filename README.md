# ThornsTube v0.0.0

Enchant yourself and gain protection while fighting against big tech.

A free, open source YouTube app that blocks ads and sponsors. It also doesn't rely on Chromium (I'm looking at Electron apps).

## Development

ThornsTube is FreeTube with the Electron shell replaced by [Tauri 2](https://tauri.app). The Vue UI in `src/renderer/` is unchanged; `src/tauri/ftElectron.js` implements the `window.ftElectron` interface that FreeTube's Electron preload script normally provides.

```bash
pnpm install
pnpm tauri dev        # desktop
pnpm tauri android build --debug --apk --target aarch64   # Android (needs Android SDK + NDK)
```

### Staying up to date with FreeTube

```bash
pnpm sync-upstream
```

This (re-)adds the `upstream` remote, fetches FreeTube's `development` branch and merges it. A weekly GitHub Action (`.github/workflows/syncUpstream.yml`) does the same and opens a pull request. If upstream changes `src/preload/interface.js`, mirror the change in `src/tauri/ftElectron.js`.

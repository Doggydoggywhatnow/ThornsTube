# ThornsTube v0.0.0

Enchant yourself and gain protection while fighting against big tech.

A free, open source YouTube app that blocks ads and sponsors. It also doesn't rely on Chromium (I'm looking at Electron apps).

## Status

Early development. The desktop app (Linux AppImage) builds and runs, and an Android project is set up and builds a debug APK. Video playback currently works through the Invidious backend; see [Known limitations](#known-limitations).

## How it works

ThornsTube is [FreeTube](https://github.com/FreeTubeApp/FreeTube) with the Electron shell replaced by [Tauri 2](https://tauri.app), so it uses the system webview instead of a bundled browser and can target Android from the same codebase.

The FreeTube UI (`src/renderer/`) and its Electron code (`src/main/`, `src/preload/`) are left untouched so upstream fixes merge cleanly. The Tauri side lives in a few new places:

| Path | Purpose |
| --- | --- |
| `src/tauri/ftElectron.js` | Implements the `window.ftElectron` interface that FreeTube's Electron preload script normally provides |
| `src/tauri/poToken.js`, `src/tauri/botGuardFrame.js` | PO token generation in an isolated frame |
| `src-tauri/` | Rust shell: window, the `native_fetch` HTTP command, the BotGuard frame's URL scheme |
| `_scripts/webpack.tauri.config.js` | Reuses FreeTube's renderer webpack config with the Tauri differences |
| `_scripts/tauriDefaultsLoader.js` | Build-time change of the default backend (see below) |

Network requests go through our own Rust command instead of the webview, which avoids CORS and keeps no cookie jar. There is no telemetry and no auto-updater.

## Building

Requires Node.js, [pnpm](https://pnpm.io), Rust, and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
```

**Linux AppImage**

```bash
pnpm tauri build --bundles appimage
```

Bundling GStreamer into the AppImage also needs `patchelf` and the GStreamer development packages (`libgstreamer1.0-dev`, `libgstreamer-plugins-base1.0-dev`, plus the `gstreamer1.0-plugins-*` and `gstreamer1.0-libav` packages). Set `GSTREAMER_INCLUDE_BAD_PLUGINS=1` to include the extra codecs. The result is in `src-tauri/target/release/bundle/appimage/`.

**Android** (needs the Android SDK and NDK; set `ANDROID_HOME` and `NDK_HOME`)

```bash
pnpm tauri android build --debug --apk --target aarch64
```

`pnpm run pack:tauri` builds just the frontend into `dist-tauri/`. The dev server (`pnpm run dev:tauri`) has not been tested.

## Staying up to date with FreeTube

```bash
pnpm sync-upstream
```

This (re-)adds the `upstream` remote, fetches FreeTube's `development` branch and merges it. A weekly GitHub Action (`.github/workflows/syncUpstream.yml`) does the same and opens a pull request.

If upstream changes `src/preload/interface.js`, mirror the change in `src/tauri/ftElectron.js`. If it changes the `backendPreference` default in `settings.js`, the build fails with a message pointing at `_scripts/tauriDefaultsLoader.js`.

## Known limitations

- **Default backend is Invidious.** The Local API needs a PO token from YouTube's BotGuard, which WebKit-based webviews (Linux, macOS) currently fail to obtain, so streams get refused. `_scripts/tauriDefaultsLoader.js` changes the default at build time. You can switch back in Settings, and users who already chose a backend keep their choice. Android's Chromium-based WebView may behave differently.
- **Picture-in-picture** is not supported by WebKitGTK ([planned](#roadmap)).
- **Not implemented yet:** default download folder, external player, multi-window sync and deep links.
- **`devtools` is enabled** in `src-tauri/Cargo.toml` for debugging (right-click, Inspect Element) and should be removed for releases.
- The app is hidden until its first frame paints; a safety timer shows it after 8 seconds if something fails.

## Roadmap

1. Picture-in-picture that works on desktop and Android. This comes before any Android GUI work.
2. Get the Local API working (valid PO token, or a client that does not need one).
3. A touch-first Android GUI in the style of the regular YouTube app, themed as ThornsTube, done as responsive CSS and layout changes.
4. Rebrand the remaining FreeTube names, icons and package metadata.

## License

AGPL-3.0-or-later, as FreeTube. See [LICENSE](LICENSE). ThornsTube is a fork and is not affiliated with the FreeTube team.

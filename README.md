<div align="center">

<img alt="SPlayer Together logo" width="120" height="120" src="public/icons/favicon.png" />

<h2>SPlayer Together</h2>

<p>🎵 Cross-platform desktop music player with rich lyric support and wide audio format compatibility.</p>

<p>Fork of <a href="https://github.com/SPlayer-Dev/SPlayer-Next">SPlayer Next</a> with new features: "Listen Together" (一起听) room collaboration, and more.</p>

[![Stars](https://img.shields.io/github/stars/Aruvelut-123/SPlayer-Together?style=flat)](https://github.com/Aruvelut-123/SPlayer-Together/stargazers)
[![Release](https://img.shields.io/github/v/release/Aruvelut-123/SPlayer-Together)](https://github.com/Aruvelut-123/SPlayer-Together/releases)
[![License](https://img.shields.io/github/license/Aruvelut-123/SPlayer-Together)](https://github.com/Aruvelut-123/SPlayer-Together/blob/main/LICENSE)
[![Issues](https://img.shields.io/github/issues/Aruvelut-123/SPlayer-Together)](https://github.com/Aruvelut-123/SPlayer-Together/issues)

**English** | [简体中文](./README.zh-CN.md)

</div>

> ⚠️ **Development Notice**: Almost all code changes in this repository were made by **DeepSeek Harness** (an AI coding agent) on behalf of the maintainer. Review the code yourself before using it in production.

---

## Features

- 🎵 **Broad format support** — MP3, FLAC, WAV, AAC, OGG, APE, and more, decoded via FFmpeg
- 📝 **Rich lyrics** — LRC / QRC / YRC / TTML, word-by-word highlighting and translations, with desktop, dynamic-island, and taskbar lyric windows
- 🌐 **Streaming servers** — Subsonic / Navidrome / Jellyfin / Emby (multi-server, auto-connect)
- 👥 **Listen Together (一起听)** — create a room, share the same queue and playback across members (a fork feature)
- 🖥️ **Cross-platform** — Windows / macOS / Linux
- 🎚️ **Audio spectrum** — real-time FFT visualization
- 🏷️ **Metadata editing** — edit local track tags and cover art
- ⬇️ **Downloads** — built-in download manager
- 🎧 **System media integration** — Windows SMTC / Linux MPRIS / macOS Now Playing + Discord RPC
- ⚡ **High-performance audio engine** — FFmpeg + Rust
- 🎨 **Adaptive theming** — cover-based colors, Light / Dark / Auto
- 📈 **Last.fm scrobbling**

## Development

### Requirements

- **Node.js** >= 22
- **pnpm** >= 10
- **Rust toolchain** (required to build the native modules; see below)

### Native Modules

Core performance features are powered by Rust-based native modules:

| Module          | Description                                                                        |
| --------------- | ---------------------------------------------------------------------------------- |
| `audio-engine`  | High-performance audio decoding (FFmpeg), playback, FFT spectrum, cover extraction |
| `media-ctrl`    | System media controls + Discord Rich Presence                                      |
| `taskbar-lyric` | Native Windows taskbar lyric rendering                                             |

`pnpm dev` and `pnpm build` compile the native modules automatically. To skip them (e.g. when working only on the UI), set `SKIP_NATIVE_BUILD=true`.

### Getting Started

```bash
# 1. Install dependencies
pnpm install

# 2. Start the dev app (builds native modules in debug, then launches Electron)
pnpm dev
```

### Building

```bash
pnpm build         # Full build: clean → native → typecheck → electron-vite

pnpm build:win     # Package for Windows
pnpm build:mac     # Package for macOS
pnpm build:linux   # Package for Linux (AppImage / deb / rpm / tar.gz / pacman)
```

> By default a build targets the current architecture only. Cross-compilation is not supported.

### Other Scripts

```bash
pnpm typecheck        # tsc + vue-tsc (node + web targets)
pnpm lint             # ESLint
pnpm format           # Prettier
pnpm build:native     # Build the Rust native modules only (add `--dev` for debug)
```

## Acknowledgements

Special thanks to the open-source projects that make SPlayer Together possible:

- [applemusic-like-lyrics](https://github.com/Steve-xmh/applemusic-like-lyrics) — Apple Music-style lyrics display component library
- [NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) — NetEase Cloud Music API (backup + enhanced)

## License

This project is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](https://www.gnu.org/licenses/agpl-3.0.html).

- **Modification & distribution:** any modification or distribution must also be released under **AGPL-3.0**, with the complete source code provided.
- **Derivative works:** must adopt **AGPL-3.0** as well, and must retain this project's license and copyright notice in an appropriate place.
- **Attribution:** the original author and copyright information must be preserved. You may add your own notice for a derivative work, but you must not remove or alter the original.
- **Commercial use:** if used for sale or any other for-profit purpose, the source code and a link to the original project must be provided. Because this project relies on third-party services, commercial use may carry legal risk.
- **No warranty:** the software is provided "as is", without warranty of any kind, as described in the AGPL-3.0.

## Disclaimer

This project is intended for personal learning and research only, and must not be used for commercial or unlawful purposes. Some features rely on third-party APIs; users are solely responsible for ensuring their use complies with the relevant laws, regulations, and service agreements. The authors accept no liability for any direct or indirect consequences arising from the use of this project.

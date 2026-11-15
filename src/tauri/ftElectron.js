// Tauri implementation of the `window.ftElectron` interface that the renderer
// normally gets from the Electron preload script (src/preload/interface.js).
//
// The renderer is intentionally left untouched so that upstream FreeTube
// changes can be merged without conflicts. When upstream adds a method to
// src/preload/interface.js, add the matching method here.
//
// This file is only bundled by _scripts/webpack.tauri.config.js.

import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

const isMobile = /android|iphone|ipad/i.test(navigator.userAgent)

const noop = () => {}

/** @type {string | null} */
let proxyUrl = null

/** @type {{ url: string, authorization: string } | null} */
let invidiousAuthorization = null

/** @type {Map<string, ArrayBuffer>} */
const playerCache = new Map()

// ---------------------------------------------------------------------------
// Networking
//
// Webviews enforce CORS, which breaks the Local API (youtubei.js talks to
// youtube.com directly). Electron works around it by rewriting headers in
// session.webRequest (see src/main/index.js). Here we route cross-origin
// requests through the Tauri HTTP plugin (Rust side, no CORS) and apply the
// same header rules.
// ---------------------------------------------------------------------------

const nativeFetch = window.fetch.bind(window)

/** @param {string} url @param {Headers} headers */
function applyHeaderRules(url, headers) {
  const urlObj = new URL(url)
  const { origin, pathname } = urlObj

  if (url.startsWith('https://www.youtube.com/youtubei/')) {
    headers.set('Referer', 'https://www.youtube.com/')
    headers.set('Origin', 'https://www.youtube.com')
    headers.set('Sec-Fetch-Site', 'same-origin')
    headers.set('Sec-Fetch-Mode', 'same-origin')
    headers.set('X-Youtube-Bootstrap-Logged-In', 'false')
  } else if (url.startsWith('https://www.youtube.com/watch') || (origin === 'https://www.youtube.com' && pathname === '/')) {
    headers.delete('Referer')
    headers.delete('Origin')
    headers.set('Sec-Fetch-Dest', 'document')
    headers.set('Sec-Fetch-Mode', 'navigate')
    headers.set('Sec-Fetch-Site', 'none')
    headers.set('Sec-Fetch-User', '?1')

    const xCookie = headers.get('X-Cookie')
    if (xCookie) {
      const cookie = headers.get('Cookie')
      headers.set('Cookie', cookie ? `${cookie};${xCookie}` : xCookie)
      headers.delete('X-Cookie')
    }
  } else if (url === 'https://www.youtube.com/sw.js_data' || url.startsWith('https://www.youtube.com/api/timedtext')) {
    headers.set('Referer', 'https://www.youtube.com/sw.js')
    headers.set('Sec-Fetch-Site', 'same-origin')
    headers.set('Sec-Fetch-Mode', 'same-origin')
  } else if (/\.(googleusercontent\.com|ggpht\.com|ytimg\.com)$/.test(urlObj.hostname)) {
    headers.set('Referer', 'https://www.youtube.com/')
    headers.set('Origin', 'https://www.youtube.com')
  } else if (urlObj.hostname.endsWith('.googlevideo.com') && pathname === '/videoplayback') {
    headers.set('Referer', 'https://www.youtube.com/')
    headers.set('Origin', 'https://www.youtube.com')
    headers.delete('Content-Type')
  } else if (invidiousAuthorization && url.startsWith(invidiousAuthorization.url)) {
    headers.set('Authorization', invidiousAuthorization.authorization)
  }
}

window.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = request.url

  // Same-origin / app-internal requests (locales, static files) stay native
  if (!/^https?:/.test(url) || new URL(url).origin === location.origin) {
    return nativeFetch(input, init)
  }

  const headers = new Headers(request.headers)
  applyHeaderRules(url, headers)

  // Never send YouTube cookies set by the webview; tracking cookies are not wanted.
  const options = {
    method: request.method,
    headers,
    body: request.body ? await request.arrayBuffer() : undefined,
    signal: request.signal
  }

  if (proxyUrl) {
    options.proxy = { all: proxyUrl }
  }

  return await tauriFetch(url, options)
}

// ---------------------------------------------------------------------------
// System theme (Electron pushes this from the main process)
// ---------------------------------------------------------------------------

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const updateSystemTheme = () => {
  document.body.dataset.systemTheme = darkQuery.matches ? 'dark' : 'light'
}
darkQuery.addEventListener('change', updateSystemTheme)
window.addEventListener('DOMContentLoaded', updateSystemTheme)

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** @type {WakeLockSentinel | null} */
let wakeLock = null

const notSupported = (name) => () => {
  console.warn(`[ThornsTube] ftElectron.${name} is not implemented on this platform`)
}

window.ftElectron = {
  getSystemLocale: async () => navigator.language || 'en-US',
  isWaylandPlatform: async () => false,

  openInNewWindow: async (path, query, searchQueryText) => {
    if (isMobile) {
      notSupported('openInNewWindow')()
      return
    }
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      const search = query ? `?${new URLSearchParams(query)}` : ''
      // eslint-disable-next-line no-new
      new WebviewWindow(`win-${Date.now()}`, { url: `index.html#${path}${search}` })
    } catch (error) {
      console.error(error)
    }
  },

  enableProxy: (url) => { proxyUrl = url },
  disableProxy: () => { proxyUrl = null },

  setInvidiousAuthorization: (authorization, url) => {
    invidiousAuthorization = authorization ? { authorization, url } : null
  },
  clearInvidiousAuthorization: () => { invidiousAuthorization = null },

  startPowerSaveBlocker: async () => {
    try {
      wakeLock = await navigator.wakeLock?.request('screen')
    } catch { /* not supported or denied */ }
  },
  stopPowerSaveBlocker: async () => {
    try { await wakeLock?.release() } catch { /* ignore */ }
    wakeLock = null
  },

  // Chromium-specific experimental flags; not applicable.
  getReplaceHttpCache: async () => false,
  getDisableHardwareAcceleration: async () => false,
  toggleReplaceHttpCache: noop,
  toggleDisableHardwareAcceleration: noop,

  requestPiP: () => {
    document.querySelector('video.player')?.ui?.getControls().togglePiP()
  },
  requestFullscreen: () => {
    document.querySelector('video.player')?.ui?.getControls().toggleFullScreen()
  },

  playerCacheGet: async (key) => playerCache.get(key),
  playerCacheSet: async (key, value) => { playerCache.set(key, value) },

  // TODO: needs a hidden webview running the BotGuard script (see src/main/poTokenGenerator.js)
  generatePoToken: async () => {
    throw new Error('PO token generation is not implemented yet')
  },

  // TODO: native folder picker + write (tauri-plugin-dialog / tauri-plugin-fs)
  chooseDefaultFolder: notSupported('chooseDefaultFolder'),
  writeToDefaultFolder: async () => false,

  relaunch: () => { location.reload() },

  // TODO: desktop only; Android needs an Intent
  openInExternalPlayer: notSupported('openInExternalPlayer'),
  handleOpenInExternalPlayerResult: noop,

  setZoomFactor: async (factor) => {
    if (isMobile) return
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      await getCurrentWebview().setZoom(factor)
    } catch (error) {
      console.error(error)
    }
  },

  getNavigationHistory: async () => [],

  // Data stores use the web (localForage/IndexedDB) handlers in this build,
  // see the DB_HANDLERS alias in _scripts/webpack.tauri.config.js.
  dbSettings: notSupported('dbSettings'),
  dbHistory: notSupported('dbHistory'),
  dbProfiles: notSupported('dbProfiles'),
  dbPlaylists: notSupported('dbPlaylists'),
  dbSearchHistory: notSupported('dbSearchHistory'),
  dbSubscriptionCache: notSupported('dbSubscriptionCache'),

  // Events pushed from Electron's main process. TODO: wire to Tauri events / deep links.
  handleChangeView: noop,
  handleOpenUrl: noop,
  handleUpdateSearchInputText: noop,
  handleSyncSettings: noop,
  handleSyncHistory: noop,
  handleSyncSearchHistory: noop,
  handleSyncProfiles: noop,
  handleSyncPlaylists: noop,
  handleSyncSubscriptionCache: noop
}

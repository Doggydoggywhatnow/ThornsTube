// Tauri implementation of the `window.ftElectron` interface that the renderer
// normally gets from the Electron preload script (src/preload/interface.js).
//
// The renderer is intentionally left untouched so that upstream FreeTube
// changes can be merged without conflicts. When upstream adds a method to
// src/preload/interface.js, add the matching method here.
//
// This file is only bundled by _scripts/webpack.tauri.config.js.

import { invoke } from '@tauri-apps/api/core'
import { generatePoToken } from './poToken'

// Electron's renderer has a `process` global; some bundled dependencies (e.g. the
// Node `util` polyfill) expect it at load time. This entry runs before them.
window.process ??= {
  env: {},
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  platform: 'browser'
}

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

  return await nativeRequest(url, {
    method: request.method,
    headers,
    body: request.body ? await request.arrayBuffer() : undefined,
    signal: request.signal
  })
}

/**
 * Sends a request through the Rust HTTP client (no CORS, no cookie jar).
 * Wire format is documented in src-tauri/src/lib.rs.
 * @param {string} url
 * @param {{ method?: string, headers?: HeadersInit, body?: ArrayBuffer | null, signal?: AbortSignal | null }} options
 * @returns {Promise<Response>}
 */
async function nativeRequest(url, options) {
  options.signal?.throwIfAborted()

  // Send what the webview itself would send, like Electron's Chromium does.
  const headers = new Headers(options.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', navigator.userAgent)
  if (!headers.has('Accept')) headers.set('Accept', '*/*')
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', navigator.languages?.join(',') || 'en-US,en;q=0.9')

  const meta = new TextEncoder().encode(JSON.stringify({
    url,
    method: options.method ?? 'GET',
    headers: [...headers.entries()],
    proxy: proxyUrl
  }))
  const body = options.body ? new Uint8Array(options.body) : new Uint8Array(0)

  const payload = new Uint8Array(4 + meta.length + body.length)
  new DataView(payload.buffer).setUint32(0, meta.length)
  payload.set(meta, 4)
  payload.set(body, 4 + meta.length)

  let raw
  try {
    raw = await invoke('native_fetch', payload)
  } catch (error) {
    // Rust returns the full error chain; keep it visible in the UI and console.
    console.error('[ThornsTube] native request failed:', error)
    throw new TypeError(String(error), { cause: error })
  }

  options.signal?.throwIfAborted()

  const view = new DataView(raw)
  const metaLength = view.getUint32(0)
  const response = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, metaLength)))
  const responseBody = raw.slice(4 + metaLength)

  const nullBody = [101, 204, 205, 304].includes(response.status)
  const result = new Response(nullBody ? null : responseBody, { status: response.status, headers: response.headers })
  Object.defineProperty(result, 'url', { value: response.url })
  return result
}

/**
 * Fetch used by the sandboxed BotGuard frame, mirrors the header rules of the
 * `potoken` session in src/main/poTokenGenerator.js.
 * @param {string} url
 * @param {RequestInit} init
 */
function botGuardFetch(url, init) {
  const headers = new Headers(init.headers)

  if (url.startsWith('https://www.youtube.com/youtubei/')) {
    applyHeaderRules(url, headers)
  } else if (url.startsWith('https://www.google.com/js/')) {
    headers.set('Sec-Fetch-Dest', 'script')
    headers.set('Sec-Fetch-Site', 'cross-site')
    headers.set('Accept-Language', '*')
  } else {
    headers.set('Referer', 'https://www.youtube.com/')
    headers.set('Origin', 'https://www.youtube.com')
    headers.set('Sec-Fetch-Dest', 'empty')
    headers.set('Sec-Fetch-Mode', 'cors')
    headers.set('Sec-Fetch-Site', 'same-origin')
  }

  return nativeRequest(url, { ...init, headers })
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

  // Runs src/botGuardScript.js in a sandboxed iframe, see ./poToken.js
  generatePoToken: (videoId, context, initialAttestationData, ytConfig) => {
    return generatePoToken(botGuardFetch, videoId, context, initialAttestationData, ytConfig)
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

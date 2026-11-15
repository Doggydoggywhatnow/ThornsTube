// PO token generation for Tauri, replacing src/main/poTokenGenerator.js.
//
// Each token is generated in a fresh sandboxed iframe (separate origin, no access
// to app storage or cookies) that is thrown away afterwards, mirroring the
// throw-away session the Electron implementation uses. The iframe's network
// requests are forwarded to the parent, which only allows a short list of
// BotGuard-related endpoints.

const ALLOWED = [
  /^https:\/\/www\.google\.com\/js\//,
  /^https:\/\/www\.youtube\.com\/youtubei\//,
  /^https:\/\/www\.youtube\.com\/api\/jnn\//,
  /^https:\/\/jnn-pa\.googleapis\.com\//
]

// Custom protocols are http://<scheme>.localhost on Windows and Android, <scheme>://localhost elsewhere
const FRAME_URL = /windows|android/i.test(navigator.userAgent)
  ? 'http://ftbotguard.localhost/frame.html'
  : 'ftbotguard://localhost/frame.html'

let queue = Promise.resolve()

/**
 * @param {(url: string, init: RequestInit) => Promise<Response>} fetchFunc
 * @param {string} videoId
 * @param {string} context
 * @param {string} initialAttestationData
 * @param {string} ytConfig
 * @returns {Promise<string>}
 */
export function generatePoToken(fetchFunc, videoId, context, initialAttestationData, ytConfig) {
  const run = () => generateInFrame(fetchFunc, [
    videoId,
    JSON.parse(context),
    JSON.parse(initialAttestationData),
    JSON.parse(ytConfig)
  ])

  // Sequential, like the Electron implementation
  const result = queue.then(run, run)
  queue = result.catch(() => {})
  return result
}

function generateInFrame(fetchFunc, args) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe')
    // The frame has its own origin (custom scheme, see src-tauri/src/lib.rs), so it cannot reach app data.
    // The sandbox still blocks top navigation, popups and forms.
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    iframe.tabIndex = -1
    // BotGuard measures the viewport, so a tiny frame looks like a bot. The Electron implementation
    // emulates 1920x1080 (src/main/poTokenGenerator.js); do the same. The frame stays inside the
    // window (but invisible and behind everything): WebKit throttles timers and animation frames of
    // iframes that are scrolled or positioned off-screen, which made the BotGuard VM time out.
    iframe.style.cssText = 'position:fixed;left:0;top:0;width:1920px;height:1080px;border:0;opacity:0;pointer-events:none;z-index:-1'
    iframe.src = FRAME_URL

    const timeout = setTimeout(() => finish(new Error('PO token generation timed out')), 60_000)

    // Last response from the token endpoints, appended to errors for diagnosis
    let lastResponse = ''
    // GenerateIT answers [integrityToken, ttl, threshold, fallbackToken]. When BotGuard attestation is
    // rejected the integrity token is null and only the (not content-bound) fallback token is present.
    let fallbackToken = null

    const finish = (error, result) => {
      clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      iframe.remove()
      if (error) reject(error)
      else resolve(result)
    }

    const onMessage = async (event) => {
      if (event.source !== iframe.contentWindow) return
      const message = event.data

      if (message.type === 'ft-ready') {
        iframe.contentWindow.postMessage({ type: 'ft-generate', args }, '*')
      } else if (message.type === 'ft-generate-result') {
        if (message.error && fallbackToken) {
          console.warn('[ThornsTube] BotGuard attestation was rejected, using the fallback PO token. Playback may be limited.')
          finish(null, fallbackToken)
        } else if (message.error) finish(new Error(`${message.error}${lastResponse ? ` [${lastResponse}]` : ''}`))
        else finish(null, message.result)
      } else if (message.type === 'ft-fetch') {
        const reply = (data, transfer) => iframe.contentWindow?.postMessage({ type: 'ft-fetch-result', id: message.id, ...data }, '*', transfer)

        if (!ALLOWED.some((pattern) => pattern.test(message.url))) {
          reply({ error: `Blocked request to ${message.url}` })
          return
        }

        try {
          const response = await fetchFunc(message.url, {
            method: message.method,
            headers: message.headers,
            body: message.body
          })
          const body = await response.arrayBuffer()

          if (message.url.endsWith('/GenerateIT')) {
            try {
              const parsed = JSON.parse(new TextDecoder().decode(body))
              if (typeof parsed[0] !== 'string' && typeof parsed[3] === 'string') fallbackToken = parsed[3]
            } catch { /* not JSON */ }
          }

          lastResponse = `${response.status} ${new URL(message.url).pathname}: ${new TextDecoder().decode(body.slice(0, 200))}`
          if (!response.ok) {
            console.error(`[ThornsTube] PO token request failed: ${response.status} ${message.url}`, lastResponse)
          }

          reply({ status: response.status, headers: [...response.headers.entries()], body }, [body])
        } catch (error) {
          reply({ error: String(error?.message ?? error) })
        }
      }
    }

    window.addEventListener('message', onMessage)
    document.body.appendChild(iframe)
  })
}

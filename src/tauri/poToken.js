// PO token generation for Tauri, replacing src/main/poTokenGenerator.js.
//
// Each token is generated in a fresh sandboxed iframe (opaque origin, no access
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
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.tabIndex = -1
    iframe.style.cssText = 'position:fixed;width:1px;height:1px;border:0;opacity:0;pointer-events:none'
    // Same dimensions BotGuard sees on the Electron path are not emulated here; the frame is 1x1.
    iframe.srcdoc = `<!doctype html><html lang="en"><head><title></title></head><body><script src="${new URL('botGuardFrame.js', location.href).href}"></script></body></html>`

    const timeout = setTimeout(() => finish(new Error('PO token generation timed out')), 60_000)

    // Last response from the token endpoints, appended to errors for diagnosis
    let lastResponse = ''

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
        if (message.error) finish(new Error(`${message.error}${lastResponse ? ` [${lastResponse}]` : ''}`))
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

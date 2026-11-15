// Runs inside a sandboxed, opaque-origin iframe (see poToken.js). It reuses the
// upstream BotGuard script unchanged; the only addition is a `fetch` that is
// forwarded to the parent window, because the sandboxed frame has no CORS
// access and must not hold any app data.
import generate from '../botGuardScript.js'

const pending = new Map()

window.fetch = (input, init = {}) => {
  const request = new Request(input, init)

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    pending.set(id, { resolve, reject })

    request.arrayBuffer().then((body) => {
      parent.postMessage({
        type: 'ft-fetch',
        id,
        url: request.url,
        method: request.method,
        headers: [...request.headers.entries()],
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body
      }, '*')
    }, reject)
  })
}

window.addEventListener('message', async (event) => {
  if (event.source !== parent) return
  const message = event.data

  if (message.type === 'ft-fetch-result') {
    const entry = pending.get(message.id)
    pending.delete(message.id)
    if (!entry) return

    if (message.error) {
      entry.reject(new TypeError(message.error))
    } else {
      // Response() rejects null-body statuses having a body
      const nullBody = [101, 204, 205, 304].includes(message.status)
      entry.resolve(new Response(nullBody ? null : message.body, { status: message.status, headers: message.headers }))
    }
  } else if (message.type === 'ft-generate') {
    try {
      const result = await generate(...message.args)
      parent.postMessage({ type: 'ft-generate-result', result }, '*')
    } catch (error) {
      parent.postMessage({ type: 'ft-generate-result', error: String(error?.message ?? error) }, '*')
    }
  }
})

parent.postMessage({ type: 'ft-ready' }, '*')

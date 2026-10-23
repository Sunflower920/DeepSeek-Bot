import { hostText, t } from './i18n.js'
import { markNoted, noteClientError } from './diagnostics.js'

const ROUTE = 'api/bot'
// Refusals carry a message meant for the user, who sees it where they acted.
const REFUSALS = new Set(['bot/refused', 'bot/invalid', 'bot/read-only', 'bot/not-found', 'bot/browser-off'])

export const call = async (endpoint, payload, signal) => {
  let response
  try {
    // Document-relative so the Web UI keeps working under a mounted base path.
    response = await fetch(ROUTE, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload: payload ?? null }),
      signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    noteClientError(endpoint, Object.assign(new Error(`network error: ${error?.message ?? error}`), { code: 'NETWORK' }))
    // The browser's own text ("Failed to fetch", "Load failed") does not say what failed.
    throw markNoted(Object.assign(new Error(t('Could not reach DSH. Check that it is still running.')), { code: 'NETWORK', cause: error }))
  }
  if (!response.ok) {
    const error = Object.assign(new Error(hostText(`HTTP ${response.status}`)), { code: `HTTP_${response.status}` })
    noteClientError(endpoint, error)
    throw error
  }
  const result = await response.json()
  if (!result.ok) {
    const code = result.error?.code ?? 'bot/error'
    const message = hostText(result.error?.message ?? 'Request failed')
    const error = Object.assign(new Error(code === 'bot/internal' ? `${message} ${t('Settings → Feedback has the details.')}` : message), { code })
    if (!REFUSALS.has(code)) {
      noteClientError(endpoint, Object.assign(new Error(result.error?.message ?? 'Request failed'), { code }))
      markNoted(error)
    }
    throw error
  }
  return result.value
}

// One endpoint answers the request itself with the file's bytes (file-open), so its
// response is read as a download instead of the JSON envelope. A refusal still comes
// back as JSON, under a 200, which is turned back into the error `call` would throw.
export const callFile = async (endpoint, payload) => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload ?? null }),
  })
  if (!response.ok) throw Object.assign(new Error(hostText(`HTTP ${response.status}`)), { code: `HTTP_${response.status}` })
  if ((response.headers.get('content-type') ?? '').includes('json')) {
    const result = await response.json()
    const code = result?.error?.code ?? 'bot/error'
    const message = hostText(result?.error?.message ?? 'Request failed')
    throw Object.assign(new Error(code === 'bot/internal' ? `${message} ${t('Settings → Feedback has the details.')}` : message), { code })
  }
  return response
}

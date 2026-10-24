// The file panel: a file a Bot sent, shown in the chat itself — an image, a PDF, a
// table's rows, a document's paragraphs, or plain text. Kinds the panel cannot render
// (an old .xls, a program) say so and offer the two things that still work: the
// download, and the app on this computer that owns the file.
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { CloseIcon, DownloadIcon } from './icons.js'
import { useEscape } from './overlay-hooks.js'
import { hostText, t } from './i18n.js'

const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'])
const TEXTS = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'tsv'])
const OFFICE = new Set(['docx', 'xlsx'])
// A file too large to hold in the panel: the byte cap the host reads.
const INLINE_MAX = 32 * 1024 * 1024

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', pdf: 'application/pdf',
}

export function extensionOf(name) {
  const dot = String(name ?? '').lastIndexOf('.')
  return dot < 0 ? '' : String(name).slice(dot + 1).toLowerCase()
}

// What the panel can do with a file before it reads a byte: 'image', 'pdf', 'text',
// 'office' (the host reads it into rows or paragraphs), or null for the rest.
export function kindOf(name, bytes) {
  const extension = extensionOf(name)
  if (IMAGES.has(extension)) return bytes !== undefined && bytes > INLINE_MAX ? null : 'image'
  if (extension === 'pdf') return bytes !== undefined && bytes > INLINE_MAX ? null : 'pdf'
  if (TEXTS.has(extension)) return 'text'
  if (OFFICE.has(extension)) return 'office'
  return null
}

export function FileDialog({ file, actions, leaving = false }) {
  const [state, setState] = useState({ phase: 'loading' })
  const [url, setUrl] = useState(null)
  const close = useCallback(() => actions.closeFile(), [])
  useEscape(close)
  const shown = useRef(null)
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  useEffect(() => {
    // One load per file: a reopened chip for the same attachment reuses the dialog.
    if (shown.current === file?.attachmentId) return
    shown.current = file?.attachmentId
    let stopped = false
    const load = async () => {
      const kind = kindOf(file?.name, file?.bytes)
      try {
        if (kind === null) {
          setState({ phase: 'unsupported' })
          return
        }
        if (kind === 'office') {
          const value = await actions.filePreview(file)
          if (stopped) return
          setState({ phase: 'ready', kind: value.kind, ...value })
          return
        }
        const blob = await actions.fileBytes(file)
        if (stopped) return
        if (kind === 'text') {
          const text = await blob.text()
          setState({ phase: 'ready', kind: 'text', text })
          return
        }
        const objectUrl = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: MIME[extensionOf(file?.name)] ?? 'application/octet-stream' }))
        setUrl(objectUrl)
        setState({ phase: 'ready', kind })
      } catch (error) {
        if (!stopped) setState({ phase: 'failed', error: error?.message ?? String(error) })
      }
    }
    void load()
    return () => { stopped = true }
  }, [file])

  const name = String(file?.name ?? '')
  const openOutside = () => actions.launchFile(file)
  const save = () => actions.downloadFile(file)
  const truncated = state.truncated === true
  return h('div', { className: 'bt-file-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim bt-file-scrim', onMouseDown: close }),
    h('div', { className: 'bt-file', role: 'dialog', 'aria-modal': true, 'aria-label': t('Preview of {name}', { name }) },
      h('div', { className: 'bt-file-head' },
        h('h2', null, name),
        h('span', { className: 'bt-file-status' }, state.kind === 'table' && state.sheet ? state.sheet : ''),
        h('span', { className: 'bt-file-head-gap' }),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Download {name}', { name }), title: t('Download'), onClick: save }, h(DownloadIcon)),
        h('button', { type: 'button', className: 'bt-icon-btn', 'aria-label': t('Close preview'), title: t('Close'), onClick: close }, h(CloseIcon))),
      h('div', { className: 'bt-file-body' },
        state.phase === 'loading' ? h('div', { className: 'bt-file-note' }, t('Loading…'))
          : state.phase === 'failed' ? h('div', { className: 'bt-error', role: 'alert' }, hostText(state.error))
            : state.phase === 'unsupported' ? h(Fragment, null,
              h('div', { className: 'bt-file-note' }, t('{name} cannot be shown here.', { name })),
              h('div', { className: 'bt-file-actions' },
                h('button', { type: 'button', className: 'bt-file-btn', onClick: openOutside }, t('Open it with its app')),
                h('button', { type: 'button', className: 'bt-file-btn', onClick: save }, t('Download'))))
              : state.kind === 'image' ? h('div', { className: 'bt-file-image' }, h('img', { src: url, alt: name }))
                : state.kind === 'pdf' ? h('iframe', { className: 'bt-file-pdf', src: url, title: name })
                  : state.kind === 'table' ? h(Fragment, null,
                    h('div', { className: 'bt-file-scroll' },
                      h('table', { className: 'bt-file-table' },
                        h('tbody', null, (state.rows ?? []).map((row, index) => h('tr', { key: index }, row.map((cell, at) => h('td', { key: at }, cell))))))),
                    truncated ? h('div', { className: 'bt-file-note' }, t('The first {count} rows.', { count: state.rows?.length ?? 0 })) : null)
                  : h(Fragment, null,
                    h('div', { className: 'bt-file-scroll' }, h('pre', { className: 'bt-file-pre' }, state.text ?? '')),
                    truncated ? h('div', { className: 'bt-file-note' }, t('The first part of the file.')) : null)),
      h('div', { className: 'bt-file-foot' },
        h('span', { className: 'bt-file-note' }, t('Showing the file inside DSH.')),
        h('button', { type: 'button', className: 'bt-file-btn', onClick: openOutside }, t('Open it with its app')))))
}

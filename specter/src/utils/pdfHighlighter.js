import { PDFDocument, rgb } from 'pdf-lib'

const ensureReadableStreamValuesSupport = () => {
  if (typeof ReadableStream === 'undefined') return
  if (typeof ReadableStream.prototype.values === 'function') return

  ReadableStream.prototype.values = async function* values() {
    const reader = this.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        yield value
      }
    } finally {
      reader.releaseLock()
    }
  }
}

const isSafariBrowser = () => {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|EdgiOS|FxiOS|Android/i.test(ua)
}

const loadPdfJs = async () => {
  if (isSafariBrowser()) {
    const pdfjs = await import('pdfjs-dist-v4/legacy/build/pdf.mjs')
    return {
      pdfjs,
      workerSrc: new URL(
        'pdfjs-dist-v4/legacy/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString(),
      mode: 'safari-v4',
    }
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return {
    pdfjs,
    workerSrc: new URL(
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString(),
    mode: 'default-v5',
  }
}

const HIGHLIGHT_STYLE = Object.freeze({
  color: rgb(1, 1, 0),
  opacity: 0.45,
  borderWidth: 0,
})

const normalizeWord = (value) => value.trim().toLowerCase()

const findOccurrences = (haystack, needle) => {
  if (!needle) return []
  const starts = []
  let start = 0

  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start)
    if (index === -1) break
    starts.push(index)
    start = index + needle.length
  }
  return starts
}

const isSearchableTextItem = (item) => Boolean(item?.str?.trim())

const getItemGeometry = (item) => {
  const transform = item?.transform ?? [0, 0, 0, 0, 0, 0]
  const width = Math.abs(item?.width || 0)
  const derivedHeight = Math.hypot(transform[2], transform[3])
  const height = Math.abs(item?.height || derivedHeight || 10)
  if (!width || !height) return null

  return {
    width,
    height,
    x: transform[4] || 0,
    y: transform[5] || 0,
  }
}

const buildRectanglesForItem = (item, targetWord) => {
  if (!isSearchableTextItem(item)) return []

  const starts = findOccurrences(item.str.toLowerCase(), targetWord)
  if (starts.length === 0) return []

  const geometry = getItemGeometry(item)
  if (!geometry) return []

  const charWidth = geometry.width / item.str.length
  return starts.map((start) => ({
    x: geometry.x + charWidth * start,
    y: geometry.y - geometry.height * 0.2,
    width: charWidth * targetWord.length,
    height: geometry.height * 1.1,
  }))
}

const drawRectangles = (pdfPage, rectangles) => {
  rectangles.forEach((rectangle) => {
    pdfPage.drawRectangle({ ...rectangle, ...HIGHLIGHT_STYLE })
  })
}

const processPage = async ({ pageNumber, sourcePdf, pdfDoc, targetWord }) => {
  const sourcePage = await sourcePdf.getPage(pageNumber)
  sourcePage.getViewport({ scale: 1, dontFlip: true })

  const textContent = await sourcePage.getTextContent({
    normalizeWhitespace: true,
  })
  const rectangles = textContent.items.flatMap((item) =>
    buildRectanglesForItem(item, targetWord),
  )

  const drawPage = pdfDoc.getPage(pageNumber - 1)
  drawRectangles(drawPage, rectangles)
  return rectangles.length
}

export async function highlightWordInPdfFile(file, rawWord) {
  const targetWord = normalizeWord(rawWord)
  if (!targetWord) {
    throw new Error('Please enter a word to scan.')
  }

  const pdfBytes = await file.arrayBuffer()
  ensureReadableStreamValuesSupport()
  const [pdfDoc, pdfSetup] = await Promise.all([
    PDFDocument.load(pdfBytes),
    loadPdfJs(),
  ])
  const { pdfjs, workerSrc, mode } = pdfSetup
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

  const sourcePdf = await pdfjs
    .getDocument({
      data: new Uint8Array(pdfBytes),
      disableWorker: true,
      disableStream: true,
      disableRange: true,
      disableAutoFetch: true,
      isEvalSupported: mode !== 'safari-v4',
    })
    .promise

  const pageNumbers = Array.from({ length: sourcePdf.numPages }, (_, i) => i + 1)
  const perPageMatches = await Promise.all(
    pageNumbers.map((pageNumber) =>
      processPage({ pageNumber, sourcePdf, pdfDoc, targetWord }),
    ),
  )
  const totalMatches = perPageMatches.reduce((sum, count) => sum + count, 0)
  const outputBytes = await pdfDoc.save()
  const outputBlob = new Blob([outputBytes], { type: 'application/pdf' })

  return { blob: outputBlob, totalMatches, targetWord }
}

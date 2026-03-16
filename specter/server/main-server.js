import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import mammoth from 'mammoth'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import { fileURLToPath } from 'node:url'

const app = express()
const PORT = process.env.PORT || 8787
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(__dirname, '..', '.runtime', 'uploads')
const DOCX_HTML_ROOT = path.resolve(__dirname, '..', '.runtime', 'docx-html')
const MAX_FILES_PER_BATCH = 5
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const BATCH_TTL_MS = 24 * 60 * 60 * 1000

await Promise.all([
  fsPromises.mkdir(STORAGE_ROOT, { recursive: true }),
  fsPromises.mkdir(DOCX_HTML_ROOT, { recursive: true }),
])

app.use(cors())
app.use(express.json({ limit: '10mb' }))

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STORAGE_ROOT),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${randomUUID()}-${file.originalname}`),
})

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
})

const db = {
  batches: new Map(),
  fileIndex: new Map(),
}

const queue = []
let activeJob = null

const nowIso = () => new Date().toISOString()
const normalize = (value) => value.trim().toLowerCase()

const getBatchOr404 = (batchId, res) => {
  console.log(`[Batch Lookup] Searching for ID: "${batchId}" (Existing IDs: ${[...db.batches.keys()].join(', ')})`)
  const batch = db.batches.get(batchId)
  if (!batch) {
    res.status(404).json({ error: 'Batch not found. Please refresh your browser.' })
    return null
  }
  return batch
}

const toPublicFile = (file) => ({
  file_id: file.id,
  name: file.name,
  size: file.size,
  extension: file.original_extension || file.extension,
  content_extension: file.extension,
  preview_type: file.docx_html_path ? 'docx-html' : 'pdf',
  converted_from_docx: file.original_extension === 'docx',
  status: file.status,
  total_findings: file.findings.length,
  error: file.error,
  storage_id: file.storage_id,
  uploaded_at: file.uploaded_at,
  reviewed_at: file.reviewed_at,
})

const toPublicBatch = (batch) => ({
  batch_id: batch.id,
  created_at: batch.created_at,
  updated_at: batch.updated_at,
  status: batch.status,
  file_count: batch.files.length,
  files: batch.files.map(toPublicFile),
})

const parsePdfPages = async (absolutePath) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const pdfBytes = await fsPromises.readFile(absolutePath)
  const sourcePdf = await pdfjs
    .getDocument({
      data: new Uint8Array(pdfBytes),
      disableWorker: true,
      disableStream: true,
      disableRange: true,
      disableAutoFetch: true,
    })
    .promise

  const pages = []
  for (let pageNumber = 1; pageNumber <= sourcePdf.numPages; pageNumber += 1) {
    const page = await sourcePdf.getPage(pageNumber)
    const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: true })
    const lines = content.items
      .map((item) => item?.str?.trim())
      .filter(Boolean)
      .map((text) => text.replace(/\s+/g, ' '))
      .filter((text) => text.length > 2)
    pages.push({ page_number: pageNumber, lines })
  }

  return pages
}

const DOCX_PAGE_LAYOUT = Object.freeze({
  width: 612,
  height: 792,
  marginX: 54,
  marginY: 64,
  fontSize: 12,
  lineHeight: 16,
  maxCharsPerLine: 90,
})

const wrapDocxParagraph = (text) => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ['']

  const words = normalized.split(' ')
  const lines = []
  let currentLine = ''

  const flushCurrent = () => {
    if (currentLine) {
      lines.push(currentLine)
      currentLine = ''
    }
  }

  words.forEach((word) => {
    if (!currentLine) {
      currentLine = word
      return
    }

    const candidate = `${currentLine} ${word}`
    if (candidate.length > DOCX_PAGE_LAYOUT.maxCharsPerLine) {
      flushCurrent()
      if (word.length > DOCX_PAGE_LAYOUT.maxCharsPerLine) {
        const chunkPattern = new RegExp(`.{1,${DOCX_PAGE_LAYOUT.maxCharsPerLine}}`, 'g')
        const chunks = word.match(chunkPattern) || [word]
        if (chunks.length > 1) {
          chunks.slice(0, -1).forEach((chunk) => lines.push(chunk))
          currentLine = chunks[chunks.length - 1]
        } else {
          currentLine = chunks[0]
        }
      } else {
        currentLine = word
      }
    } else {
      currentLine = candidate
    }
  })

  flushCurrent()
  return lines.length > 0 ? lines : ['']
}

const buildDocxHtmlDocument = (bodyContent) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        font-family: 'Times New Roman', Georgia, serif;
        margin: 32px;
        background: #f4f5f8;
        color: #111;
      }
      table {
        border-collapse: collapse;
        width: 100%;
        margin: 1rem 0;
      }
      td, th {
        border: 1px solid #bbb;
        padding: 0.4rem;
        text-align: left;
      }
      h1, h2, h3, h4, h5, h6 {
        margin-top: 1.2rem;
      }
      p {
        margin: 0.4rem 0;
      }
    </style>
  </head>
  <body>
    ${bodyContent}
  </body>
</html>`

const convertDocxAssets = async ({ sourcePath, storageId }) => {
  const [{ value: rawText = '' }, { value: htmlFragment = '' }] = await Promise.all([
    mammoth.extractRawText({ path: sourcePath }),
    mammoth.convertToHtml({ path: sourcePath }),
  ])

  const normalized = rawText.replace(/\r/g, '')
  const paragraphs = normalized.length > 0 ? normalized.split('\n') : []

  const pdfDoc = await PDFDocument.create()
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman)
  const pageSize = [DOCX_PAGE_LAYOUT.width, DOCX_PAGE_LAYOUT.height]
  let page = pdfDoc.addPage(pageSize)
  let cursorY = DOCX_PAGE_LAYOUT.height - DOCX_PAGE_LAYOUT.marginY

  const ensureRoom = () => {
    if (cursorY <= DOCX_PAGE_LAYOUT.marginY) {
      page = pdfDoc.addPage(pageSize)
      cursorY = DOCX_PAGE_LAYOUT.height - DOCX_PAGE_LAYOUT.marginY
    }
  }

  const stepCursor = (amount) => {
    cursorY -= amount
    if (cursorY <= DOCX_PAGE_LAYOUT.marginY) {
      page = pdfDoc.addPage(pageSize)
      cursorY = DOCX_PAGE_LAYOUT.height - DOCX_PAGE_LAYOUT.marginY
    }
  }

  const drawLine = (line) => {
    ensureRoom()
    page.drawText(line, {
      x: DOCX_PAGE_LAYOUT.marginX,
      y: cursorY,
      size: DOCX_PAGE_LAYOUT.fontSize,
      font,
    })
    stepCursor(DOCX_PAGE_LAYOUT.lineHeight)
  }

  if (paragraphs.length === 0 || normalized.trim().length === 0) {
    drawLine('(empty DOCX)')
  } else {
    paragraphs.forEach((paragraph) => {
      const trimmed = paragraph.trim()
      if (!trimmed) {
        stepCursor(DOCX_PAGE_LAYOUT.lineHeight)
        return
      }

      wrapDocxParagraph(trimmed).forEach(drawLine)
      stepCursor(DOCX_PAGE_LAYOUT.lineHeight * 0.5)
    })
  }

  const pdfBytes = await pdfDoc.save()
  const outputPath = path.join(
    STORAGE_ROOT,
    `${Date.now()}-${randomUUID()}-docx.pdf`,
  )
  await fsPromises.writeFile(outputPath, pdfBytes)

  const htmlDocument = buildDocxHtmlDocument(htmlFragment || '<p>(empty)</p>')
  const htmlPath = path.join(DOCX_HTML_ROOT, `${storageId}.html`)
  await fsPromises.writeFile(htmlPath, htmlDocument, 'utf8')

  return { pdfPath: outputPath, htmlPath }
}

const tryParseJson = (raw) => {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) return null
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

const aiAnalyzeDocument = async ({ fullText, ruleText }) => {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat'
  const model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:1.5b'

  console.log(`Analyzing document with ${fullText.length} chars of text and ${ruleText.length} chars of rules.`)

  const content = [
    'You are a senior compliance reviewer. Reason through the provided document text and identify if it follows the given RULE.',
    'For any violations or points of interest, provide a JSON array of findings.',
    'Each item schema: {page_number:number, quote_text:string, reason:string, severity:"low"|"medium"|"high"}.',
    'Return ONLY the JSON array.',
    `RULE:\n${ruleText}`,
    `DOCUMENT TEXT:\n${fullText}`,
  ].join('\n\n')

  try {
    const response = await fetch(ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        format: 'json',
        stream: false,
        options: { temperature: 0 },
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Ollama error response:', errorText)
      throw new Error(`Ollama API error (${response.status}): ${errorText}`)
    }

    const payload = await response.json()
    const responseContent = payload?.message?.content || ''
    console.log(`AI response received (${responseContent.length} chars).`)
    const parsed = tryParseJson(responseContent)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.error('aiAnalyzeDocument failed:', err)
    throw err
  }
}

const processJob = async (job) => {
  const batch = db.batches.get(job.batch_id)
  if (!batch) return
  const file = batch.files.find((entry) => entry.id === job.file_id)
  if (!file) return

  file.status = 'processing'
  file.error = null
  batch.status = 'processing'
  batch.updated_at = nowIso()

  try {
    const pages = await parsePdfPages(file.absolute_path)
    const fullText = pages
      .map((p) => `[Page ${p.page_number}]\n${p.lines.join('\n')}`)
      .join('\n\n')

    const rawFindings = await aiAnalyzeDocument({ fullText, ruleText: job.rule_text })

    file.findings = rawFindings.map(f => ({
      finding_id: randomUUID(),
      file_id: file.id,
      page_number: f.page_number || 1,
      quote_text: f.quote_text || 'N/A',
      reason: f.reason || 'No reason provided',
      severity: f.severity || 'medium',
      status: 'open',
    }))

    file.status = 'ready'
    file.reviewed_at = nowIso()
    batch.updated_at = nowIso()

    const statuses = batch.files.map((entry) => entry.status)
    if (statuses.every((v) => v === 'ready' || v === 'failed')) {
      batch.status = statuses.some((v) => v === 'failed') ? 'partial' : 'ready'
    }
  } catch (error) {
    console.error('Job processing error:', error)
    file.status = 'failed'
    file.error = error.message.includes('Ollama API error') 
      ? `AI Server Error: ${error.message}`
      : `Document Error: ${error.message}`
    batch.status = 'partial'
    batch.updated_at = nowIso()
  }
}

const runQueue = async () => {
  if (activeJob || queue.length === 0) return
  activeJob = queue.shift()
  try {
    await processJob(activeJob)
  } finally {
    activeJob = null
    setImmediate(runQueue)
  }
}

const enqueueBatchJobs = ({ batch, ruleText }) => {
  batch.files.forEach((file) => {
    file.status = 'queued'
    queue.push({ batch_id: batch.id, file_id: file.id, rule_text: ruleText })
  })
  batch.status = 'queued'
  batch.updated_at = nowIso()
  runQueue()
}

setInterval(async () => {
  const deadline = Date.now() - BATCH_TTL_MS
  for (const [batchId, batch] of db.batches.entries()) {
    if (new Date(batch.created_at).getTime() > deadline) continue
    for (const file of batch.files) {
      db.fileIndex.delete(file.storage_id)
      await Promise.all([
        fsPromises.rm(file.absolute_path, { force: true }).catch(() => {}),
        file.docx_html_path ? fsPromises.rm(file.docx_html_path, { force: true }).catch(() => {}) : Promise.resolve(),
      ])
    }
    db.batches.delete(batchId)
  }
}, 60 * 60 * 1000)

app.get('/api/health', (_req, res) => res.json({ ok: true, now: nowIso() }))

app.post('/api/review-batches', (_req, res) => {
  const id = randomUUID()
  const batch = { id, status: 'draft', files: [], created_at: nowIso(), updated_at: nowIso() }
  db.batches.set(id, batch)
  res.status(201).json(toPublicBatch(batch))
})

app.post('/api/review-batches/:batchId/files', upload.array('files', MAX_FILES_PER_BATCH), async (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res)
  if (!batch) return

  const uploadedFiles = req.files || []
  const rejected = []
  const accepted = []

  for (const file of uploadedFiles) {
    const extension = file.originalname.split('.').pop()?.toLowerCase() || ''
    if (!['pdf', 'docx'].includes(extension)) {
      rejected.push({ name: file.originalname, reason: 'Only PDF and DOCX files are allowed.' })
      await fsPromises.rm(file.path, { force: true }).catch(() => {})
      continue
    }

    let absolutePath = file.path
    let storedExtension = extension
    let originalExtension = null
    let docxHtmlPath = null
    const storageId = randomUUID()

    if (extension === 'docx') {
      try {
        const { pdfPath, htmlPath } = await convertDocxAssets({ sourcePath: file.path, storageId })
        absolutePath = pdfPath
        await fsPromises.rm(file.path, { force: true }).catch(() => {})
        storedExtension = 'pdf'
        originalExtension = 'docx'
        docxHtmlPath = htmlPath
      } catch (error) {
        rejected.push({ name: file.originalname, reason: `Failed to convert DOCX: ${error.message}` })
        await fsPromises.rm(file.path, { force: true }).catch(() => {})
        continue
      }
    }

    const entry = {
      id: randomUUID(),
      storage_id: storageId,
      name: file.originalname,
      size: file.size,
      extension: storedExtension,
      original_extension: originalExtension,
      absolute_path: absolutePath,
      docx_html_path: docxHtmlPath,
      status: 'uploaded',
      findings: [],
      error: null,
      uploaded_at: nowIso(),
    }
    batch.files.push(entry)
    db.fileIndex.set(storageId, { batch_id: batch.id, file_id: entry.id, absolute_path: absolutePath, docx_html_path: docxHtmlPath })
    accepted.push(toPublicFile(entry))
  }
  res.status(201).json({ accepted, rejected, batch: toPublicBatch(batch) })
})

app.get('/api/review-batches/:batchId/status', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res)
  if (!batch) return
  res.json(toPublicBatch(batch))
})

app.post('/api/review-batches/:batchId/run', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res)
  if (!batch) return
  const { rule_text_override: ruleText } = req.body || {}
  enqueueBatchJobs({ batch, ruleText })
  res.status(202).json(toPublicBatch(batch))
})

app.get('/api/review-batches/:batchId/files/:fileId/findings', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res)
  if (!batch) return
  const file = batch.files.find((e) => e.id === req.params.fileId)
  if (!file) return res.status(404).json({ error: 'File not found.' })
  res.json({ file: toPublicFile(file), findings: file.findings })
})

app.get('/api/files/:storageId/content', (req, res) => {
  const index = db.fileIndex.get(req.params.storageId)
  if (!index) return res.status(404).json({ error: 'Not found.' })
  res.setHeader('Content-Type', 'application/pdf')
  fs.createReadStream(index.absolute_path).pipe(res)
})

app.get('/api/files/:storageId/docx-preview', (req, res) => {
  const index = db.fileIndex.get(req.params.storageId)
  if (!index || !index.docx_html_path) return res.status(404).json({ error: 'Not found.' })
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  fs.createReadStream(index.docx_html_path).pipe(res)
})

app.listen(PORT, () => console.log(`Main Server running on http://localhost:${PORT}`))

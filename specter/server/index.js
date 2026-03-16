import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import multer from 'multer'
import mammoth from 'mammoth'
import { PDFDocument, StandardFonts } from 'pdf-lib'

const app = express()
const PORT = process.env.PORT || 8787
const STORAGE_ROOT = path.resolve(process.cwd(), '.runtime', 'uploads')
const DOCX_HTML_ROOT = path.resolve(STORAGE_ROOT, 'docx-html')
const MAX_FILES_PER_BATCH = 5
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const BATCH_TTL_MS = 24 * 60 * 60 * 1000
const PAGE_CHUNK_SIZE = 3

await Promise.all([
  fsPromises.mkdir(STORAGE_ROOT, { recursive: true }),
  fsPromises.mkdir(DOCX_HTML_ROOT, { recursive: true }),
])

app.use(cors())
app.use(express.json({ limit: '1mb' }))

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
  ruleTemplates: new Map(),
  fileIndex: new Map(),
}

const queue = []
let activeJob = null

//const seedTemplateId = randomUUID()
//db.ruleTemplates.set(seedTemplateId, {
//  id: seedTemplateId,
//  name: 'Default SOW Policy',
//  rule_text:
//    'Flag statements that have ambiguous obligations, missing ownership, missing acceptance criteria, uncapped liability language, or undefined payment milestones.',
//  created_at: new Date().toISOString(),
//  updated_at: new Date().toISOString(),
//})

const nowIso = () => new Date().toISOString()

const normalize = (value) => value.trim().toLowerCase()

const getBatchOr404 = (batchId, res) => {
  const batch = db.batches.get(batchId)
  if (!batch) {
    res.status(404).json({ error: 'Batch not found.' })
    return null
  }
  return batch
}

const getDefaultRuleText = () => [...db.ruleTemplates.values()][0]?.rule_text || ''

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

const buildChunks = (pages) => {
  const chunks = []
  for (let index = 0; index < pages.length; index += PAGE_CHUNK_SIZE) {
    const slice = pages.slice(index, index + PAGE_CHUNK_SIZE)
    chunks.push({
      chunk_id: `chunk-${index / PAGE_CHUNK_SIZE + 1}`,
      start_page: slice[0].page_number,
      end_page: slice[slice.length - 1].page_number,
      pages: slice,
    })
  }
  return chunks
}

const toChunkPrompt = (chunk) =>
  chunk.pages
    .map((page) => `Page ${page.page_number}\n${page.lines.join('\n')}`)
    .join('\n\n')

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

const aiAnalyzeChunk = async ({ chunk, ruleText }) => {
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate'
  const model = process.env.OLLAMA_MODEL || 'deepseek-r1:7b'

  const prompt = [
    'You are RAP reviewer, just catch one that are not obeying the rule',
    `RULE:\n${ruleText}`,
    `PAGES:\n${toChunkPrompt(chunk)}`,
  ].join('\n\n')

  console.log('--- LLM REQUEST ---')
  console.log(`Model: ${model}`)
  console.log(`Prompt: ${prompt}`)
  console.log('-------------------')

  const response = await fetch(ollamaUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      prompt,
      format: 'json',
      stream: false,
      options: {
        temperature: 0,
      },
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`--- LLM ERROR ---`)
    console.error(`Status: ${response.status}`)
    console.error(`Body: ${errorText}`)
    console.error(`-----------------`)
    throw new Error(`Ollama error: ${response.status} ${errorText}`)
  }

  const payload = await response.json()
  const content = payload?.response || ''

  console.log('--- LLM RESPONSE ---')
  console.log(content)
  console.log('--------------------')

  const parsed = tryParseJson(content)
  if (!Array.isArray(parsed)) return []
  return parsed
}

const validateFinding = (finding) =>
  finding &&
  Number.isInteger(finding.page_number) &&
  typeof finding.quote_text === 'string' &&
  finding.quote_text.trim() &&
  typeof finding.reason === 'string' &&
  finding.reason.trim()

const enrichFinding = (finding, fileId, chunk) => ({
  finding_id: randomUUID(),
  file_id: fileId,
  page_number: finding.page_number,
  quote_text: finding.quote_text.trim(),
  reason: finding.reason.trim(),
  severity: ['low', 'medium', 'high'].includes(finding.severity) ? finding.severity : 'medium',
  confidence:
    typeof finding.confidence === 'number' && finding.confidence >= 0 && finding.confidence <= 1
      ? finding.confidence
      : 0.5,
  rule_clause_ref: finding.rule_clause_ref || 'general',
  bbox: [],
  status: 'open',
  chunk_id: chunk.chunk_id,
  start_page: chunk.start_page,
  end_page: chunk.end_page,
})

const dedupeFindings = (findings) => {
  const seen = new Set()
  return findings.filter((finding) => {
    const key = `${normalize(finding.quote_text)}|${finding.page_number}|${normalize(finding.rule_clause_ref || 'general')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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
    const chunks = buildChunks(pages)
    const allFindings = []

    for (const chunk of chunks) {
      const chunkFindings = await aiAnalyzeChunk({ chunk, ruleText: job.rule_text })
      
      if (!Array.isArray(chunkFindings)) {
        throw new Error('AI analysis failed.')
      }

      chunkFindings
        .filter(validateFinding)
        .map((finding) => enrichFinding(finding, file.id, chunk))
        .forEach((finding) => allFindings.push(finding))
    }

    file.findings = dedupeFindings(allFindings)
    file.status = 'ready'
    file.reviewed_at = nowIso()
    batch.updated_at = nowIso()

    const statuses = batch.files.map((entry) => entry.status)
    if (statuses.every((value) => value === 'ready' || value === 'failed')) {
      batch.status = statuses.some((value) => value === 'failed') ? 'partial' : 'ready'
    }
  } catch (error) {
    file.status = 'failed'
    file.error = 'Ollama server is not running or returned an error.'
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

const enqueueBatchJobs = ({ batch, ruleTemplateId, ruleText }) => {
  batch.files.forEach((file) => {
    if (file.extension !== 'pdf') {
      file.status = 'failed'
      file.error = 'Only PDF analysis is supported in v1.'
      return
    }
    file.status = 'queued'
    file.error = null
    queue.push({
      batch_id: batch.id,
      file_id: file.id,
      rule_template_id: ruleTemplateId,
      rule_text: ruleText,
    })
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, now: nowIso() })
})

app.post('/api/review-batches', (_req, res) => {
  const id = randomUUID()
  const batch = {
    id,
    status: 'draft',
    files: [],
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  db.batches.set(id, batch)
  res.status(201).json(toPublicBatch(batch))
})

app.post('/api/review-batches/:batchId/files', upload.array('files', MAX_FILES_PER_BATCH), async (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res)
  if (!batch) return

  const uploadedFiles = req.files || []
  if (uploadedFiles.length === 0) {
    res.status(400).json({ error: 'No files uploaded.' })
    return
  }

  if (batch.files.length + uploadedFiles.length > MAX_FILES_PER_BATCH) {
    uploadedFiles.forEach((file) => fsPromises.rm(file.path, { force: true }).catch(() => {}))
    res.status(400).json({ error: `Maximum ${MAX_FILES_PER_BATCH} files per batch.` })
    return
  }

  const rejected = []
  const accepted = []

  for (const file of uploadedFiles) {
    const extension = file.originalname.split('.').pop()?.toLowerCase() || ''
    if (!['pdf', 'docx'].includes(extension)) {
      rejected.push({ name: file.originalname, reason: 'Only PDF and DOCX files are allowed for review.' })
      await fsPromises.rm(file.path, { force: true }).catch(() => {})
      continue
    }

    let absolutePath = file.path
    let storedExtension = extension
    let originalExtension = null
    let docxHtmlPath = null

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

    const storageId = randomUUID()
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
      reviewed_at: null,
    }
    batch.files.push(entry)
    db.fileIndex.set(storageId, {
      batch_id: batch.id,
      file_id: entry.id,
      absolute_path: absolutePath,
      docx_html_path: docxHtmlPath || null,
    })
    accepted.push(toPublicFile(entry))
  }

  batch.updated_at = nowIso()
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

  if (batch.files.length === 0) {
    res.status(400).json({ error: 'Upload at least one PDF before running review.' })
    return
  }

  const { rule_template_id: ruleTemplateId, rule_text_override: ruleOverride } = req.body || {}
  const template = ruleTemplateId ? db.ruleTemplates.get(ruleTemplateId) : null
  const ruleText = (ruleOverride || template?.rule_text || getDefaultRuleText()).trim()

  if (!ruleText) {
    res.status(400).json({ error: 'Rule text is required.' })
    return
  }

  enqueueBatchJobs({ batch, ruleTemplateId: ruleTemplateId || template?.id || null, ruleText })
  res.status(202).json(toPublicBatch(batch))
})

app.get('/api/review-batches/:batchId/files/:fileId/findings', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res)
  if (!batch) return

  const file = batch.files.find((entry) => entry.id === req.params.fileId)
  if (!file) {
    res.status(404).json({ error: 'File not found in batch.' })
    return
  }

  res.json({ file: toPublicFile(file), findings: file.findings })
})

app.patch('/api/review-batches/:batchId/files/:fileId/findings/:findingId', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res)
  if (!batch) return

  const file = batch.files.find((entry) => entry.id === req.params.fileId)
  if (!file) {
    res.status(404).json({ error: 'File not found in batch.' })
    return
  }

  const finding = file.findings.find((entry) => entry.finding_id === req.params.findingId)
  if (!finding) {
    res.status(404).json({ error: 'Finding not found.' })
    return
  }

  const { status } = req.body || {}
  if (!['open', 'accepted', 'dismissed', 'needs_follow_up'].includes(status)) {
    res.status(400).json({ error: 'Invalid finding status.' })
    return
  }

  finding.status = status
  res.json({ finding })
})

app.get('/api/rule-templates', (_req, res) => {
  res.json({ templates: [...db.ruleTemplates.values()] })
})

app.post('/api/rule-templates', (req, res) => {
  const name = req.body?.name?.trim()
  const ruleText = req.body?.rule_text?.trim()
  if (!name || !ruleText) {
    res.status(400).json({ error: 'name and rule_text are required.' })
    return
  }

  const template = {
    id: randomUUID(),
    name,
    rule_text: ruleText,
    created_at: nowIso(),
    updated_at: nowIso(),
  }
  db.ruleTemplates.set(template.id, template)
  res.status(201).json(template)
})

app.patch('/api/rule-templates/:templateId', (req, res) => {
  const template = db.ruleTemplates.get(req.params.templateId)
  if (!template) {
    res.status(404).json({ error: 'Template not found.' })
    return
  }

  const name = req.body?.name?.trim()
  const ruleText = req.body?.rule_text?.trim()
  if (name) template.name = name
  if (ruleText) template.rule_text = ruleText
  template.updated_at = nowIso()

  res.json(template)
})

app.get('/api/files/:storageId/content', (req, res) => {
  const index = db.fileIndex.get(req.params.storageId)
  if (!index) {
    res.status(404).json({ error: 'File content not found.' })
    return
  }

  res.setHeader('Content-Type', 'application/pdf')
  fs.createReadStream(index.absolute_path).pipe(res)
})

app.get('/api/files/:storageId/docx-preview', (req, res) => {
  const index = db.fileIndex.get(req.params.storageId)
  if (!index || !index.docx_html_path) {
    res.status(404).json({ error: 'DOCX preview not found.' })
    return
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  fs.createReadStream(index.docx_html_path).pipe(res)
})

app.use((error, _req, res, _next) => {
  void _next
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File is greater than ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB.` })
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: `Maximum ${MAX_FILES_PER_BATCH} files per batch.` })
    }
    return res.status(400).json({ error: error.message })
  }
  res.status(500).json({ error: error.message || 'Unexpected server error.' })
})

app.listen(PORT, () => {
  console.log(`SOW review API running on http://localhost:${PORT}`)
})

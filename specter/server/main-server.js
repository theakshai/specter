import { aiAnalyzeDocument } from './ai-analyzer.js'
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
import http from 'node:http'

const app = express()
const PORT = process.env.PORT || 8787
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(__dirname, '..', '.runtime', 'uploads')
const DOCX_HTML_ROOT = path.resolve(__dirname, '..', '.runtime', 'docx-html')
const LOG_FILE = path.resolve(__dirname, 'api.logs')
const AI_DEBUG_LOG = path.resolve(__dirname, 'ai-debug.log') // New debug file
const MAX_FILES_PER_BATCH = 5
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024
const BATCH_TTL_MS = 24 * 60 * 60 * 1000

// File Logging Setup
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' })
const aiDebugStream = fs.createWriteStream(AI_DEBUG_LOG, { flags: 'a' }) // Stream for AI details

const originalLog = console.log
const originalError = console.error

console.log = (...args) => {
  const msg = `[${new Date().toISOString()}] LOG: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`
  logStream.write(msg)
  originalLog(...args)
}

console.error = (...args) => {
  const msg = `[${new Date().toISOString()}] ERROR: ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`
  logStream.write(msg)
  originalError(...args)
}

// Helper for heavy AI logging
const logAiTrace = (title, content) => {
  const separator = '='.repeat(80);
  const msg = `\n${separator}\n[${new Date().toISOString()}] ${title}\n${separator}\n${content}\n${separator}\n`;
  aiDebugStream.write(msg);
}

await Promise.all([
  fsPromises.mkdir(STORAGE_ROOT, { recursive: true }),
  fsPromises.mkdir(DOCX_HTML_ROOT, { recursive: true }),
])

app.use(cors())
app.use(express.json({ limit: '20mb' }))

app.use((req, res, next) => {
  console.log(`[Incoming Request] ${req.method} ${req.url}`);
  next();
})

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

const getBatchOr404 = (batchId, res) => {
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
  thought: file.thought, // Pass thought process to frontend
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
const tryParseJson = (raw) => {
  if (!raw) return null
  try {
    let cleanRaw = raw

    // Strip ALL known thinking tag formats
    const thinkPatterns = [
      [/<think>[\s\S]*?<\/think>/g, ''],
      [/<thought>[\s\S]*?<\/thought>/g, ''],
      [/<reasoning>[\s\S]*?<\/reasoning>/g, ''],
    ]
    for (const [pattern, replacement] of thinkPatterns) {
      cleanRaw = cleanRaw.replace(pattern, replacement)
    }
    cleanRaw = cleanRaw.trim()

    // Strip markdown code fences if present
    cleanRaw = cleanRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

    let parsed = null
    try {
      parsed = JSON.parse(cleanRaw)
    } catch {
      const match = cleanRaw.match(/\[[\s\S]*\]/) || cleanRaw.match(/\{[\s\S]*\}/)
      if (!match) return null
      parsed = JSON.parse(match[0])
    }

    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'object' && Object.keys(parsed).length > 0) return [parsed]
    return []
  } catch {
    return null
  }
}


const processJob = async (job) => {
  const batch = db.batches.get(job.batch_id)
  if (!batch) return
  const file = batch.files.find((entry) => entry.id === job.file_id)
  if (!file) return

  console.log(`[Job Start] Analyzing whole file: ${file.name}`);
  file.status = 'processing'
  batch.status = 'processing'
  batch.updated_at = nowIso()

  try {
    const pages = await parsePdfPages(file.absolute_path)

const { findings: rawFindings, thought } = await aiAnalyzeDocument({
  pages,                          // ← pass pages directly, not fullText
  ruleText: job.rule_text,
  logTrace: logAiTrace,           // ← wire up your existing logger
})

    file.thought = thought;
    file.findings = rawFindings.map(f => ({
      finding_id: randomUUID(),
      file_id: file.id,
      page_number: parseInt(f.page_number) || 1,
      category: f.category || 'General',
      violation_title: f.violation_title || 'Compliance Issue',
      quote_text: f.quote_text || 'N/A',
      reason: f.reason || f.reason_for_the_checkup || 'No reason provided',
      recommendation: f.recommendation || 'Review and revise this section per RAP guidelines.',
      severity: ['high', 'medium', 'low'].includes(String(f.severity).toLowerCase()) ? f.severity.toLowerCase() : 'medium',
      status: 'open',
    }))

    console.log(`[Job Complete] File: ${file.name}, Findings: ${file.findings.length}`);
    file.status = 'ready'
    file.reviewed_at = nowIso()
    batch.updated_at = nowIso()

    const statuses = batch.files.map((v) => v.status)
    if (statuses.every((v) => v === 'ready' || v === 'failed')) {
      batch.status = statuses.some((v) => v === 'failed') ? 'partial' : 'ready'
    }
  } catch (error) {
    console.error(`[Job Error] File: ${file.name}, Error:`, error);
    file.status = 'failed'
    file.error = `Error: ${error.message}`
    batch.status = 'partial'
    batch.updated_at = nowIso()
  }
}

const runQueue = async () => {
  if (activeJob || queue.length === 0) return
  activeJob = queue.shift()
  try { await processJob(activeJob) } finally { activeJob = null; setImmediate(runQueue) }
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

// DOCX conversion
const convertDocxAssets = async ({ sourcePath, storageId }) => {
  const [{ value: rawText = '' }, { value: htmlFragment = '' }] = await Promise.all([
    mammoth.extractRawText({ path: sourcePath }),
    mammoth.convertToHtml({ path: sourcePath }),
  ])
  const pdfDoc = await PDFDocument.create(); const font = await pdfDoc.embedFont(StandardFonts.TimesRoman)
  let page = pdfDoc.addPage([612, 792]); let cursorY = 728
  const drawLine = (line) => {
    if (cursorY < 50) { page = pdfDoc.addPage([612, 792]); cursorY = 728 }
    page.drawText(line, { x: 50, y: cursorY, size: 11, font }); cursorY -= 14
  }
  rawText.split('\n').forEach(drawLine)
  const pdfBytes = await pdfDoc.save(); const outputPath = path.join(STORAGE_ROOT, `${Date.now()}-${randomUUID()}-docx.pdf`)
  await fsPromises.writeFile(outputPath, pdfBytes)
  const htmlPath = path.join(DOCX_HTML_ROOT, `${storageId}.html`)
  await fsPromises.writeFile(htmlPath, `<!doctype html><html><body>${htmlFragment}</body></html>`, 'utf8')
  return { pdfPath: outputPath, htmlPath }
}

// Routes
app.get('/api/health', (_req, res) => res.json({ ok: true, now: nowIso() }))
app.post('/api/review-batches', (_req, res) => {
  const id = randomUUID(); const batch = { id, status: 'draft', files: [], created_at: nowIso(), updated_at: nowIso() }
  db.batches.set(id, batch); res.status(201).json(toPublicBatch(batch))
})
app.post('/api/review-batches/:batchId/files', upload.array('files', MAX_FILES_PER_BATCH), async (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res); if (!batch) return
  for (const file of req.files || []) {
    const extension = file.originalname.split('.').pop()?.toLowerCase() || ''
    let absolutePath = file.path; let storedExt = extension; let origExt = null; let htmlPath = null; const storageId = randomUUID()
    if (extension === 'docx') {
      try { const { pdfPath, htmlPath: h } = await convertDocxAssets({ sourcePath: file.path, storageId })
        absolutePath = pdfPath; storedExt = 'pdf'; origExt = 'docx'; htmlPath = h
      } catch (err) { console.error('DOCX failed:', err); continue }
    }
    const entry = { id: randomUUID(), storage_id: storageId, name: file.originalname, size: file.size, extension: storedExt, original_extension: origExt, absolute_path: absolutePath, docx_html_path: htmlPath, status: 'uploaded', findings: [], error: null, uploaded_at: nowIso() }
    batch.files.push(entry); db.fileIndex.set(storageId, { batch_id: batch.id, file_id: entry.id, absolute_path: absolutePath, docx_html_path: htmlPath })
  }
  res.status(201).json({ accepted: batch.files.map(toPublicFile), batch: toPublicBatch(batch) })
})
app.get('/api/review-batches/:batchId/status', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res); if (!batch) return; res.json(toPublicBatch(batch))
})
app.post('/api/review-batches/:batchId/run', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res); if (!batch) return; const { rule_text_override: ruleText } = req.body || {}
  enqueueBatchJobs({ batch, ruleText }); res.status(202).json(toPublicBatch(batch))
})
app.get('/api/review-batches/:batchId/files/:fileId/findings', (req, res) => {
  const batch = getBatchOr404(req.params.batchId, res); if (!batch) return; const file = batch.files.find((e) => e.id === req.params.fileId)
  if (!file) return res.status(404).json({ error: 'File not found.' }); res.json({ file: toPublicFile(file), findings: file.findings })
})
app.get('/api/files/:storageId/content', (req, res) => {
  const index = db.fileIndex.get(req.params.storageId); if (!index) return res.status(404).json({ error: 'Not found.' })
  res.setHeader('Content-Type', 'application/pdf'); fs.createReadStream(index.absolute_path).pipe(res)
})
app.get('/api/files/:storageId/docx-preview', (req, res) => {
  const index = db.fileIndex.get(req.params.storageId); if (!index || !index.docx_html_path) return res.status(404).json({ error: 'Not found.' })
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); fs.createReadStream(index.docx_html_path).pipe(res)
})

app.listen(PORT, () => console.log(`Main Server running on http://localhost:${PORT}`))

import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import multer from 'multer'

const app = express()
const PORT = process.env.PORT || 8787
const STORAGE_ROOT = path.resolve(process.cwd(), '.runtime', 'uploads')
const MAX_FILES_PER_BATCH = 5
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const BATCH_TTL_MS = 24 * 60 * 60 * 1000
const PAGE_CHUNK_SIZE = 3

await fsPromises.mkdir(STORAGE_ROOT, { recursive: true })

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

const seedTemplateId = randomUUID()
db.ruleTemplates.set(seedTemplateId, {
  id: seedTemplateId,
  name: 'Default SOW Policy',
  rule_text:
    'Flag statements that have ambiguous obligations, missing ownership, missing acceptance criteria, uncapped liability language, or undefined payment milestones.',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
})

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
  extension: file.extension,
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

const extractRuleTerms = (ruleText) => {
  const lower = ruleText.toLowerCase()
  const candidates = new Set()
  const stopWords = new Set([
    'flag',
    'line',
    'lines',
    'with',
    'the',
    'word',
    'words',
    'that',
    'are',
    'is',
    'not',
    'following',
    'rule',
    'rules',
    'a',
    'an',
    'and',
    'or',
    'of',
    'to',
    'in',
    'for',
  ])
  const patterns = [
    /(?:must not|should not|avoid|forbidden|prohibited)\s+([a-z0-9 ,-]+)/g,
    /(?:missing|undefined|ambiguous)\s+([a-z0-9 ,-]+)/g,
    /(?:with\s+the\s+word|word)\s+([a-z0-9_-]+)/g,
  ]

  patterns.forEach((pattern) => {
    let match
    while ((match = pattern.exec(lower)) !== null) {
      match[1]
        .split(',')
        .map((term) => term.trim())
        .filter((term) => term.length > 2)
        .forEach((term) => candidates.add(term))
    }
  })

  if (candidates.size === 0) {
    lower
      .split(/[^a-z0-9_-]+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 2 && !stopWords.has(term))
      .forEach((term) => candidates.add(term))
  }

  if (candidates.size === 0) {
    ;['ambiguous', 'liability', 'indemnify', 'milestone', 'acceptance criteria'].forEach((term) => {
      candidates.add(term)
    })
  }

  return [...candidates]
}

const fallbackAnalyzeChunk = ({ chunk, ruleText }) => {
  const terms = extractRuleTerms(ruleText)
  const findings = []

  chunk.pages.forEach((page) => {
    page.lines.forEach((line) => {
      const lineLower = line.toLowerCase()
      const matchedTerm = terms.find((term) => lineLower.includes(term))
      if (!matchedTerm) return

      findings.push({
        page_number: page.page_number,
        quote_text: line.slice(0, 280),
        reason: `Potential rule violation due to term: ${matchedTerm}`,
        severity: 'medium',
        confidence: 0.62,
        rule_clause_ref: matchedTerm,
      })
    })
  })

  return findings
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
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return null

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini'
  const prompt = [
    'You are a strict SOW compliance reviewer.',
    'Given RULE and PAGE TEXT, return only JSON array.',
    'Each item schema: {page_number:number, quote_text:string, reason:string, severity:"low"|"medium"|"high", confidence:number, rule_clause_ref:string}.',
    'Return only findings where quote_text exists verbatim in provided page text.',
    `RULE:\n${ruleText}`,
    `PAGES:\n${toChunkPrompt(chunk)}`,
  ].join('\n\n')

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`OpenAI error: ${response.status} ${errorText}`)
  }

  const payload = await response.json()
  const content = payload?.output_text || payload?.output?.[0]?.content?.[0]?.text || ''
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
      let chunkFindings = []
      try {
        const aiFindings = await aiAnalyzeChunk({ chunk, ruleText: job.rule_text })
        chunkFindings = Array.isArray(aiFindings) ? aiFindings : []
      } catch {
        chunkFindings = []
      }

      if (chunkFindings.length === 0) {
        chunkFindings = fallbackAnalyzeChunk({ chunk, ruleText: job.rule_text })
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
    file.error = error.message
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
      try {
        await fsPromises.rm(file.absolute_path, { force: true })
      } catch {
        // ignore cleanup errors
      }
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

app.post('/api/review-batches/:batchId/files', upload.array('files', MAX_FILES_PER_BATCH), (req, res) => {
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

  uploadedFiles.forEach((file) => {
    const extension = file.originalname.split('.').pop()?.toLowerCase() || ''
    if (!['pdf'].includes(extension)) {
      rejected.push({ name: file.originalname, reason: 'Only PDF files are allowed for review.' })
      fsPromises.rm(file.path, { force: true }).catch(() => {})
      return
    }

    const storageId = randomUUID()
    const entry = {
      id: randomUUID(),
      storage_id: storageId,
      name: file.originalname,
      size: file.size,
      extension,
      absolute_path: file.path,
      status: 'uploaded',
      findings: [],
      error: null,
      uploaded_at: nowIso(),
      reviewed_at: null,
    }
    batch.files.push(entry)
    db.fileIndex.set(storageId, { batch_id: batch.id, file_id: entry.id, absolute_path: file.path })
    accepted.push(toPublicFile(entry))
  })

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

app.use((error, _req, res) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'File is greater than 2MB.' })
    return
  }
  res.status(500).json({ error: error.message || 'Unexpected server error.' })
})

app.listen(PORT, () => {
  console.log(`SOW review API running on http://localhost:${PORT}`)
})

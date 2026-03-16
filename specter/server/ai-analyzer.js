/**
 * TWO-PASS AI ANALYSIS ENGINE
 * Drop-in replacement for aiAnalyzeDocument in main-server.js
 *
 * PASS 1 — Coverage Map: Where does each rule appear in the document?
 * PASS 2 — Deep Validate: For each rule that exists, is it properly satisfied?
 *
 * This eliminates false positives from chunk isolation.
 */

import http from 'node:http'

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://127.0.0.1:11434/api/chat'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'deepseek-r1:7b'

// Keep context small for 7B — quality degrades above 8k
const CTX_SIZE     = 8192
const TIMEOUT_MS   = 600_000 // 10 min

// ─── RULES (parsed from your RULE.md) ────────────────────────────────────────
// Each rule has: id, category, question, severity if missing

const RAP_RULES = [
  {
    id: 'scope_boundaries',
    category: 'Scope',
    question: 'Are scope boundaries clearly defined? No open-ended statements like "as needed", "as requested", "as necessary".',
    severity_if_missing: 'high',
  },
  {
    id: 'scope_phases',
    category: 'Scope',
    question: 'Are phases or milestones explicitly defined in the scope?',
    severity_if_missing: 'medium',
  },
  {
    id: 'out_of_scope',
    category: 'Out-of-Scope',
    question: 'Is there an explicit Out-of-Scope section listing specific exclusions? "Anything not listed is out of scope" alone is NOT acceptable.',
    severity_if_missing: 'high',
  },
  {
    id: 'deliverables',
    category: 'Deliverables',
    question: 'Are all deliverables explicitly and specifically listed? Vague statements like "provide documentation as necessary" are violations.',
    severity_if_missing: 'high',
  },
  {
    id: 'timeline',
    category: 'Timeline',
    question: 'Is the timeline tied to specific deliverables and milestones? Vague durations like "12 months of support" with no checkpoints are violations.',
    severity_if_missing: 'medium',
  },
  {
    id: 'staffing',
    category: 'Staffing',
    question: 'Is staffing appropriate? Are roles clearly defined? Is there architect oversight? Is staffing phased according to project milestones?',
    severity_if_missing: 'medium',
  },
  {
    id: 'delivery_responsibilities',
    category: 'Responsibilities',
    question: 'Are the responsibilities of Presidio and the customer clearly articulated separately?',
    severity_if_missing: 'medium',
  },
  {
    id: 'assumptions',
    category: 'Assumptions',
    question: 'Are project-specific assumptions explicitly documented beyond standard delivery assumptions?',
    severity_if_missing: 'low',
  },
  {
    id: 'special_requests',
    category: 'Special Requests',
    question: 'If there are special working hours or conditions, are they explicitly mentioned and reflected in the cost?',
    severity_if_missing: 'low',
  },
  {
    id: 'india_margin',
    category: 'Margin',
    question: 'Is the India margin above 55-60%? Can margin compliance be verified from the SOW?',
    severity_if_missing: 'high',
  },
  {
    id: 'shadowing',
    category: 'Shadowing & Travel',
    question: 'For engagements 3+ months with 3+ team members, are shadowing hours included in the SOW?',
    severity_if_missing: 'medium',
  },
  {
    id: 'skillset',
    category: 'Skillset',
    question: 'Can the scope be delivered by the DevOps & Migration India Delivery team? Are skillset gaps identified?',
    severity_if_missing: 'medium',
  },
]

// ─── HELPER: RAW OLLAMA CALL ──────────────────────────────────────────────────

const callOllama = (messages) =>
  new Promise((resolve, reject) => {
    const url  = new URL(OLLAMA_URL)
    const body = JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      options: {
        temperature: 0,
        num_ctx: CTX_SIZE,
        num_predict: 2048,
        repeat_penalty: 1.1,
      },
    })

    const req = http.request(
      {
        hostname: url.hostname,
        port:     url.port,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Ollama ${res.statusCode}: ${data}`))
          }
          try {
            const payload = JSON.parse(data)
            resolve(payload?.message?.content || '')
          } catch (err) {
            reject(err)
          }
        })
      }
    )

    req.on('error',   reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')) })
    req.write(body)
    req.end()
  })

// ─── HELPER: STRIP THINKING TAGS + PARSE JSON ────────────────────────────────

const extractJson = (raw) => {
  if (!raw) return null
  let clean = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<thought>[\s\S]*?<\/thought>/g, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/g, '')
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```$/m, '')
    .trim()

  try { return JSON.parse(clean) } catch { /* fall through */ }

  const arrMatch = clean.match(/\[[\s\S]*\]/)
  const objMatch = clean.match(/\{[\s\S]*\}/)
  const match = arrMatch || objMatch
  if (!match) return null

  try { return JSON.parse(match[0]) } catch { return null }
}

// ─── CHUNK DOCUMENT INTO ~3000 CHAR SECTIONS ─────────────────────────────────
// Keeps each chunk well inside the 8k context window alongside the prompt

const chunkDocument = (pages) => {
  const MAX_CHUNK_CHARS = 3000
  const chunks = []
  let current = { pages: [], text: '' }

  for (const page of pages) {
    const pageText = `[Page ${page.page_number}]\n${page.lines.join('\n')}`
    if (current.text.length + pageText.length > MAX_CHUNK_CHARS && current.text) {
      chunks.push({ ...current })
      current = { pages: [], text: '' }
    }
    current.pages.push(page.page_number)
    current.text += '\n\n' + pageText
  }
  if (current.text) chunks.push(current)
  return chunks
}

// ─── PASS 1: COVERAGE MAP ────────────────────────────────────────────────────
// For each rule, scan ALL chunks to find WHERE it is addressed.
// Returns: Map<ruleId, { found: boolean, pages: number[], evidence: string }>

const buildCoverageMap = async (chunks, ruleText, logTrace) => {
  const coverageMap = {}
  for (const rule of RAP_RULES) {
    coverageMap[rule.id] = { found: false, pages: [], evidence: '' }
  }

  console.log(`[PASS 1] Scanning ${chunks.length} chunks for rule coverage...`)

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    console.log(`[PASS 1] Chunk ${i + 1}/${chunks.length} (pages: ${chunk.pages.join(',')})`)

    const ruleChecklist = RAP_RULES.map((r) =>
      `- "${r.id}": ${r.question}`
    ).join('\n')

    const messages = [
      {
        role: 'system',
        content: `You are a document scanner. Your ONLY job is to check if each rule topic is addressed in the given document section.
Answer ONLY with a JSON object. No explanation. No extra text.`,
      },
      {
        role: 'user',
        content: `DOCUMENT SECTION (Pages ${chunk.pages.join(', ')}):
${chunk.text}

RULES TO CHECK (answer true/false for each):
${ruleChecklist}

Respond ONLY with a JSON object like this:
{
  "scope_boundaries": { "found": true, "evidence": "exact quote from text if found, else empty string" },
  "scope_phases": { "found": false, "evidence": "" },
  ... (one entry per rule id)
}`,
      },
    ]

    logTrace(`[PASS 1] Chunk ${i + 1} INPUT`, JSON.stringify(messages, null, 2))

    try {
      const raw = await callOllama(messages)
      logTrace(`[PASS 1] Chunk ${i + 1} OUTPUT`, raw)

      const parsed = extractJson(raw)
      if (!parsed) {
        console.log(`[PASS 1] Could not parse chunk ${i + 1}, skipping`)
        continue
      }

      // Merge results — if ANY chunk says found, it's found
      for (const rule of RAP_RULES) {
        const result = parsed[rule.id]
        if (result?.found === true) {
          coverageMap[rule.id].found = true
          coverageMap[rule.id].pages.push(...chunk.pages)
          if (result.evidence && !coverageMap[rule.id].evidence) {
            coverageMap[rule.id].evidence = result.evidence
          }
        }
      }
    } catch (err) {
      console.error(`[PASS 1] Chunk ${i + 1} error:`, err.message)
    }
  }

  console.log('[PASS 1] Coverage map built:', JSON.stringify(coverageMap, null, 2))
  return coverageMap
}

// ─── PASS 2: DEEP VALIDATE ────────────────────────────────────────────────────
// For rules that WERE found: validate quality
// For rules NOT found: immediately flag as missing (no AI call needed)

const deepValidate = async (coverageMap, chunks, logTrace) => {
  const findings = []
  let thought = ''

  // Rules NOT found → immediate violations (no false positives)
  for (const rule of RAP_RULES) {
    if (!coverageMap[rule.id].found) {
      console.log(`[PASS 2] Rule "${rule.id}" NOT FOUND in document → auto-flag`)
      findings.push({
        page_number: null,
        category: rule.category,
        violation_title: `Missing: ${rule.category}`,
        quote_text: 'N/A — section not found in document',
        reason: `The document does not address: ${rule.question}`,
        severity: rule.severity_if_missing,
        recommendation: `Add a dedicated section covering: ${rule.question}`,
      })
    }
  }

  // Rules that WERE found → validate quality
  const foundRules = RAP_RULES.filter((r) => coverageMap[r.id].found)
  console.log(`[PASS 2] Deep validating ${foundRules.length} found rules...`)

  for (const rule of foundRules) {
    const coverage = coverageMap[rule.id]

    // Get the relevant chunks for this rule
    const relevantChunks = chunks.filter((c) =>
      c.pages.some((p) => coverage.pages.includes(p))
    )
    const relevantText = relevantChunks.map((c) => c.text).join('\n\n').slice(0, 3000)

    console.log(`[PASS 2] Validating rule "${rule.id}" on pages ${coverage.pages.join(',')}`)

    const messages = [
      {
        role: 'system',
        content: `You are a strict RAP Compliance Reviewer. Your job is to validate whether a specific rule is PROPERLY satisfied in a document section — not just mentioned, but actually fulfilled with sufficient detail and specificity.

Be strict. Vague mentions do not count. Only flag if there is a real, specific violation.
Respond ONLY with a JSON object. No explanation outside the JSON.`,
      },
      {
        role: 'user',
        content: `RULE TO VALIDATE:
Category: ${rule.category}
Question: ${rule.question}

DOCUMENT SECTION:
${relevantText}

Is this rule properly and specifically satisfied? 

Respond ONLY with:
{
  "violation_found": true or false,
  "violation_title": "short title if violation found, else null",
  "quote_text": "the exact problematic quote from the document, or null",
  "reason": "specific explanation of WHY this violates the rule, or null",
  "severity": "high|medium|low or null",
  "recommendation": "specific fix required, or null",
  "page_number": <page number where issue found, or null>
}`,
      },
    ]

    logTrace(`[PASS 2] Rule "${rule.id}" INPUT`, JSON.stringify(messages, null, 2))

    try {
      const raw = await callOllama(messages)
      logTrace(`[PASS 2] Rule "${rule.id}" OUTPUT`, raw)

      // Extract thought if present
      if (raw.includes('<think>') && raw.includes('</think>')) {
        thought += `\n\n[${rule.id}] ` + raw.split('<think>')[1].split('</think>')[0].trim()
      }

      const parsed = extractJson(raw)
      if (!parsed) {
        console.log(`[PASS 2] Could not parse result for rule "${rule.id}", skipping`)
        continue
      }

      if (parsed.violation_found === true) {
        findings.push({
          page_number: parsed.page_number || coverage.pages[0] || null,
          category: rule.category,
          violation_title: parsed.violation_title || `${rule.category} Violation`,
          quote_text: parsed.quote_text || coverage.evidence || 'N/A',
          reason: parsed.reason || 'Violation found but no reason provided',
          severity: ['high', 'medium', 'low'].includes(String(parsed.severity).toLowerCase())
            ? parsed.severity.toLowerCase()
            : rule.severity_if_missing,
          recommendation: parsed.recommendation || 'Review and revise per RAP guidelines.',
        })
      }
    } catch (err) {
      console.error(`[PASS 2] Rule "${rule.id}" error:`, err.message)
    }
  }

  return { findings, thought: thought.trim() || null }
}

// ─── MAIN EXPORT: DROP-IN REPLACEMENT ────────────────────────────────────────

export const aiAnalyzeDocument = async ({ pages, ruleText, logTrace = () => {} }) => {
  console.log(`[AI] Starting two-pass analysis. Model: ${OLLAMA_MODEL}`)

  const chunks = chunkDocument(pages)
  console.log(`[AI] Document split into ${chunks.length} chunks`)

  // PASS 1 — build coverage map
  const coverageMap = await buildCoverageMap(chunks, ruleText, logTrace)

  // PASS 2 — validate found rules, auto-flag missing ones
  const { findings, thought } = await deepValidate(coverageMap, chunks, logTrace)

  console.log(`[AI] Analysis complete. Total findings: ${findings.length}`)
  return { findings, thought }
}

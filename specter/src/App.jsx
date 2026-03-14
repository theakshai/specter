import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import Button from './components/Button'
import PdfViewer from './components/PdfViewer'

const API_ROOT = '/api'

function App() {
  const [batch, setBatch] = useState(null)
  const [templates, setTemplates] = useState([])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [ruleText, setRuleText] = useState('')
  const [selectedFileId, setSelectedFileId] = useState(null)
  const [findingsByFile, setFindingsByFile] = useState({})
  const [activeFindingId, setActiveFindingId] = useState(null)
  const [isRunning, setIsRunning] = useState(false)
  const [toasts, setToasts] = useState([])
  const fileInputRef = useRef(null)

  const files = useMemo(() => batch?.files || [], [batch?.files])
  const selectedFile = files.find((file) => file.file_id === selectedFileId) || files[0]
  const selectedFindings = findingsByFile[selectedFile?.file_id] || []

  const isBatchWorking = useMemo(
    () => files.some((file) => ['queued', 'processing'].includes(file.status)),
    [files],
  )

  const addToast = (message, type = 'success') => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts((current) => [...current, { id, message, type }])
    setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id))
    }, 3500)
  }

  const refreshStatus = useCallback(async (batchId) => {
    const response = await fetch(`${API_ROOT}/review-batches/${batchId}/status`)
    if (!response.ok) throw new Error('Failed to fetch batch status.')
    const payload = await response.json()
    setBatch(payload)

    if (!selectedFileId && payload.files.length > 0) {
      setSelectedFileId(payload.files[0].file_id)
    }

    return payload
  }, [selectedFileId])

  const loadFindings = useCallback(async (batchId, fileId) => {
    if (!batchId || !fileId) return
    const response = await fetch(`${API_ROOT}/review-batches/${batchId}/files/${fileId}/findings`)
    if (!response.ok) throw new Error('Failed to fetch findings.')
    const payload = await response.json()
    setFindingsByFile((current) => ({ ...current, [fileId]: payload.findings }))
    if (!activeFindingId && payload.findings.length > 0) {
      setActiveFindingId(payload.findings[0].finding_id)
    }
  }, [activeFindingId])

  useEffect(() => {
    let ignore = false

    const bootstrap = async () => {
      try {
        const [batchResponse, templateResponse] = await Promise.all([
          fetch(`${API_ROOT}/review-batches`, { method: 'POST' }),
          fetch(`${API_ROOT}/rule-templates`),
        ])

        if (!batchResponse.ok) throw new Error('Failed to create review batch.')
        if (!templateResponse.ok) throw new Error('Failed to load rule templates.')

        const batchPayload = await batchResponse.json()
        const templatePayload = await templateResponse.json()

        if (ignore) return

        setBatch(batchPayload)
        setTemplates(templatePayload.templates)

        if (templatePayload.templates.length > 0) {
          setSelectedTemplateId(templatePayload.templates[0].id)
          setRuleText(templatePayload.templates[0].rule_text)
        }
      } catch (error) {
        if (!ignore) addToast(`✖ ${error.message}`, 'error')
      }
    }

    bootstrap()
    return () => {
      ignore = true
    }
  }, [])

  useEffect(() => {
    if (!selectedTemplateId) return
    const template = templates.find((item) => item.id === selectedTemplateId)
    if (template) {
      setRuleText(template.rule_text)
    }
  }, [selectedTemplateId, templates])

  useEffect(() => {
    if (!batch?.batch_id || !selectedFile?.file_id) return
    if (selectedFile.status !== 'ready' && selectedFile.status !== 'partial') return
    loadFindings(batch.batch_id, selectedFile.file_id).catch((error) => {
      addToast(`✖ ${error.message}`, 'error')
    })
  }, [batch?.batch_id, selectedFile?.file_id, selectedFile?.status, loadFindings])

  useEffect(() => {
    if (!batch?.batch_id || !isBatchWorking) return undefined

    const intervalId = setInterval(() => {
      refreshStatus(batch.batch_id)
        .then((payload) => {
          const stillWorking = payload.files.some((file) => ['queued', 'processing'].includes(file.status))
          if (!stillWorking) {
            setIsRunning(false)
          }
        })
        .catch((error) => {
          addToast(`✖ ${error.message}`, 'error')
        })
    }, 2000)

    return () => clearInterval(intervalId)
  }, [batch?.batch_id, isBatchWorking, refreshStatus])

  const onUploadClick = () => {
    fileInputRef.current?.click()
  }

  const onUploadChange = async (event) => {
    if (!batch?.batch_id) return

    const pickedFiles = Array.from(event.target.files || [])
    if (pickedFiles.length === 0) return

    const formData = new FormData()
    pickedFiles.forEach((file) => formData.append('files', file))

    try {
      const response = await fetch(`${API_ROOT}/review-batches/${batch.batch_id}/files`, {
        method: 'POST',
        body: formData,
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to upload files.')
      }

      setBatch(payload.batch)
      if (!selectedFileId && payload.batch.files.length > 0) {
        setSelectedFileId(payload.batch.files[0].file_id)
      }

      payload.rejected.forEach((item) => addToast(`⚠ ${item.name}: ${item.reason}`, 'error'))
      addToast(`✔ Uploaded ${payload.accepted.length} file(s).`, 'success')
    } catch (error) {
      addToast(`✖ ${error.message}`, 'error')
    } finally {
      event.target.value = ''
    }
  }

  const onRunReview = async () => {
    if (!batch?.batch_id) return
    if (files.length === 0) {
      addToast('⚠ Upload 1-5 PDFs before running review.', 'error')
      return
    }

    setIsRunning(true)
    try {
      const response = await fetch(`${API_ROOT}/review-batches/${batch.batch_id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rule_template_id: selectedTemplateId || null,
          rule_text_override: ruleText,
        }),
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to start review run.')
      }

      setBatch(payload)
      addToast('✔ Review started. Processing files in background.', 'success')
    } catch (error) {
      setIsRunning(false)
      addToast(`✖ ${error.message}`, 'error')
    }
  }

  const onSaveTemplate = async () => {
    if (!ruleText.trim()) {
      addToast('⚠ Rule text cannot be empty.', 'error')
      return
    }

    try {
      let response
      if (selectedTemplateId) {
        response = await fetch(`${API_ROOT}/rule-templates/${selectedTemplateId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rule_text: ruleText }),
        })
      } else {
        response = await fetch(`${API_ROOT}/rule-templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `Template ${templates.length + 1}`, rule_text: ruleText }),
        })
      }

      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to save template.')
      }

      const templateResponse = await fetch(`${API_ROOT}/rule-templates`)
      const templatePayload = await templateResponse.json()
      setTemplates(templatePayload.templates)
      setSelectedTemplateId(payload.id)
      addToast('✔ Rule template saved.', 'success')
    } catch (error) {
      addToast(`✖ ${error.message}`, 'error')
    }
  }

  const updateFindingStatus = async (findingId, status) => {
    if (!batch?.batch_id || !selectedFile?.file_id) return

    try {
      const response = await fetch(
        `${API_ROOT}/review-batches/${batch.batch_id}/files/${selectedFile.file_id}/findings/${findingId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        },
      )
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Failed to update finding.')

      setFindingsByFile((current) => ({
        ...current,
        [selectedFile.file_id]: (current[selectedFile.file_id] || []).map((finding) =>
          finding.finding_id === findingId ? payload.finding : finding,
        ),
      }))
    } catch (error) {
      addToast(`✖ ${error.message}`, 'error')
    }
  }

  const viewerFileSource = selectedFile ? `${API_ROOT}/files/${selectedFile.storage_id}/content` : null

  return (
    <main className={`app ${files.length > 0 ? 'viewer-mode' : ''}`}>
      {files.length === 0 && (
        <section className="empty-start">
          <h1 className="title">Specter</h1>
          <p className="subtitle">AI assisted SOW reviewer with human in loop</p>
          <Button label="Upload PDFs" onClick={onUploadClick} />
        </section>
      )}

      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept=".pdf,application/pdf"
        multiple
        onChange={onUploadChange}
      />

      {files.length > 0 && (
        <>
          <nav className="viewer-navbar">
            <div className="rule-controls">
              <select
                className="rule-select"
                value={selectedTemplateId}
                onChange={(event) => setSelectedTemplateId(event.target.value)}
              >
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
              <Button label="Save Rule" className="scan-button" onClick={onSaveTemplate} />
              <Button
                label={isRunning || isBatchWorking ? 'Running...' : 'Run Review'}
                className="scan-button"
                onClick={onRunReview}
              />
              <Button label="Upload" className="scan-button" onClick={onUploadClick} />
            </div>
          </nav>

          <section className="workspace scan-open">
            <div className="viewer-shell">
              <aside className="file-sidebar">
                <h2 className="file-sidebar-title">Files</h2>
                <ul className="accepted-files">
                  {files.map((file) => (
                    <li key={file.file_id}>
                      <button
                        type="button"
                        className={`file-item ${selectedFile?.file_id === file.file_id ? 'active' : ''}`}
                        onClick={() => {
                          setSelectedFileId(file.file_id)
                          setActiveFindingId(null)
                        }}
                      >
                        <span>📄</span>
                        <span>{file.name}</span>
                        <span className={`status-pill ${file.status}`}>{file.status}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </aside>
              <div className="viewer-panel">
                {selectedFile ? (
                  <PdfViewer
                    fileSource={viewerFileSource}
                    findings={selectedFindings}
                    activeFindingId={activeFindingId}
                  />
                ) : (
                  <p className="empty-text">Select a file to preview.</p>
                )}
              </div>
            </div>

            <aside className="scan-chatbar">
              <h2 className="scan-title">Review Findings</h2>
              <textarea
                className="rule-editor"
                value={ruleText}
                onChange={(event) => setRuleText(event.target.value)}
                placeholder="Write rule prompt used for SOW review..."
              />
              <div className="scan-messages">
                {selectedFindings.length === 0 ? (
                  <p className="scan-empty">No findings yet for this file.</p>
                ) : (
                  selectedFindings.map((finding) => (
                    <div
                      key={finding.finding_id}
                      className={`scan-message ${activeFindingId === finding.finding_id ? 'user' : 'assistant'}`}
                      onClick={() => setActiveFindingId(finding.finding_id)}
                    >
                      <p><strong>Page {finding.page_number}</strong></p>
                      <p>{finding.quote_text}</p>
                      <p>{finding.reason}</p>
                      <div className="finding-actions">
                        <button type="button" onClick={() => updateFindingStatus(finding.finding_id, 'accepted')}>Accept</button>
                        <button type="button" onClick={() => updateFindingStatus(finding.finding_id, 'dismissed')}>Dismiss</button>
                        <button type="button" onClick={() => updateFindingStatus(finding.finding_id, 'needs_follow_up')}>Needs Follow-up</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </aside>
          </section>
        </>
      )}

      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </main>
  )
}

export default App

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import Button from './components/Button'
import PdfViewer from './components/PdfViewer'

const API_ROOT = '/api'

function App() {
  const [batch, setBatch] = useState(null)
  const [ruleText, setRuleText] = useState('')
  const [selectedFileId, setSelectedFileId] = useState(null)
  const [findingsByFile, setFindingsByFile] = useState({})
  const [activeFindingId, setActiveFindingId] = useState(null)
  const [isRunning, setIsRunning] = useState(false)
  const [toasts, setToasts] = useState([])
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)
  const ruleInputRef = useRef(null)

  const MAX_FILES_PER_BATCH = 5
  const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
  const MAX_RULE_SIZE_BYTES = 500 * 1024 * 1024

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

  const onRuleUploadClick = () => {
    ruleInputRef.current?.click()
  }

  const onRuleUploadChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (file.name !== 'RULE.txt') {
      addToast('⚠ Only a file named "RULE.txt" is allowed.', 'error')
      event.target.value = ''
      return
    }

    if (file.size > MAX_RULE_SIZE_BYTES) {
      addToast('⚠ RULE.txt must be 500MB or less.', 'error')
      event.target.value = ''
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target.result
      setRuleText(text)
      addToast('✔ RULE.txt loaded successfully.', 'success')
    }
    reader.onerror = () => {
      addToast('✖ Failed to read RULE.txt.', 'error')
    }
    reader.readAsText(file)
    event.target.value = ''
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
        const response = await fetch(`${API_ROOT}/review-batches`, { method: 'POST' })
        if (!response.ok) throw new Error('Failed to create review batch.')
        const payload = await response.json()

        if (!ignore) {
          setBatch(payload)
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
          // Check for newly failed files to show toast
          payload.files.forEach(file => {
            if (file.status === 'failed' && file.error) {
               addToast(`✖ ${file.name}: ${file.error}`, 'error');
            }
          });
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

  const onFolderUploadClick = () => {
    folderInputRef.current?.click()
  }

  const onUploadChange = async (event) => {
    if (!batch?.batch_id) return

    let pickedFiles = Array.from(event.target.files || [])
    if (pickedFiles.length === 0) return

    // Filter for PDFs and DOCXs
    const originalCount = pickedFiles.length
    const allowedExtensions = ['.pdf', '.docx']
    pickedFiles = pickedFiles.filter((file) =>
      allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    )
    const validExtCount = pickedFiles.length

    if (validExtCount === 0) {
      if (originalCount > 0) {
        addToast('⚠ No PDF or DOCX files found in selection.', 'error')
      }
      event.target.value = ''
      return
    }

    // Check if we already have too many files
    const currentFilesCount = files.length
    if (currentFilesCount + validExtCount > MAX_FILES_PER_BATCH) {
      addToast(
        `⚠ Total files cannot exceed ${MAX_FILES_PER_BATCH}. You tried to add ${validExtCount}, but only ${
          MAX_FILES_PER_BATCH - currentFilesCount
        } more are allowed.`,
        'error',
      )
      event.target.value = ''
      return
    }

    // Check size for each file
    const validFiles = []
    const rejectedFiles = []

    pickedFiles.forEach((file) => {
      if (file.size > MAX_FILE_SIZE_BYTES) {
        rejectedFiles.push({ name: file.name, reason: 'File is larger than 2MB.' })
      } else {
        validFiles.push(file)
      }
    })

    rejectedFiles.forEach((item) => addToast(`⚠ ${item.name}: ${item.reason}`, 'error'))

    if (validFiles.length === 0) {
      event.target.value = ''
      return
    }

    const formData = new FormData()
    validFiles.forEach((file) => formData.append('files', file))

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

      if (payload.rejected) {
        payload.rejected.forEach((item) => addToast(`⚠ ${item.name}: ${item.reason}`, 'error'))
      }
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
      addToast('⚠ Upload 1-5 PDFs or DOCXs before running review.', 'error')
      return
    }

    setIsRunning(true)
    try {
      const response = await fetch(`${API_ROOT}/review-batches/${batch.batch_id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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

  const viewerFileSource = useMemo(() => {
    if (!selectedFile) return null
    if (selectedFile.preview_type === 'docx-html') {
      return {
        type: 'docx-html',
        url: `${API_ROOT}/files/${selectedFile.storage_id}/docx-preview`,
      }
    }
    return { type: 'pdf', url: `${API_ROOT}/files/${selectedFile.storage_id}/content` }
  }, [selectedFile])

  return (
    <main className={`app ${files.length > 0 ? 'viewer-mode' : ''}`}>
      {files.length === 0 && (
        <section className="empty-start">
          <h1 className="title">Specter</h1>
          <p className="subtitle">AI assisted SOW reviewer with human in loop</p>
          <div className="button-group">
            <Button label="Upload Files" onClick={onUploadClick} />
            <Button label="Upload Folder" onClick={onFolderUploadClick} />
          </div>
        </section>
      )}

      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept=".pdf,application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        multiple
        onChange={onUploadChange}
      />
      <input
        ref={folderInputRef}
        className="hidden-input"
        type="file"
        webkitdirectory=""
        directory=""
        multiple
        onChange={onUploadChange}
      />
      <input
        ref={ruleInputRef}
        className="hidden-input"
        type="file"
        accept=".txt"
        onChange={onRuleUploadChange}
      />

      {files.length > 0 && (
        <>
          <nav className="viewer-navbar">
            <div className="rule-controls">
              <Button label="Upload Rule" className="scan-button" onClick={onRuleUploadClick} />
              <Button
                label={isRunning || isBatchWorking ? 'Running...' : 'Run Review'}
                className="scan-button primary"
                onClick={onRunReview}
              />
              <Button label="Upload" className="scan-button" onClick={onUploadClick} />
              <Button label="Upload Folder" className="scan-button" onClick={onFolderUploadClick} />
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
                    file={selectedFile}
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

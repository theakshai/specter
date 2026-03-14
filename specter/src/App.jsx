import { useEffect, useRef, useState } from 'react'
import './App.css'
import Button from './components/Button'
import { highlightWordInPdfFile } from './utils/pdfHighlighter'

const MAX_SIZE_BYTES = 2 * 1024 * 1024
const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx'])

function App() {
  const [acceptedFiles, setAcceptedFiles] = useState([])
  const [selectedFileId, setSelectedFileId] = useState(null)
  const [toasts, setToasts] = useState([])
  const [isScanOpen, setIsScanOpen] = useState(false)
  const [scanInput, setScanInput] = useState('')
  const [scanMessages, setScanMessages] = useState([])
  const [isScanning, setIsScanning] = useState(false)
  const filesInputRef = useRef(null)
  const previousFilesRef = useRef([])

  useEffect(() => {
    const previousFiles = previousFilesRef.current
    const currentFileUrls = new Set(acceptedFiles.map((file) => file.url))

    previousFiles.forEach((file) => {
      if (!currentFileUrls.has(file.url)) {
        URL.revokeObjectURL(file.url)
      }
    })

    previousFilesRef.current = acceptedFiles
  }, [acceptedFiles])

  useEffect(
    () => () => {
      previousFilesRef.current.forEach((file) => URL.revokeObjectURL(file.url))
    },
    [],
  )

  const addToast = (message, type) => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts((currentToasts) => [...currentToasts, { id, message, type }])
    setTimeout(() => {
      setToasts((currentToasts) =>
        currentToasts.filter((toast) => toast.id !== id),
      )
    }, 4000)
  }

  const handleSelection = (fileList) => {
    const selectedFiles = Array.from(fileList ?? [])
    if (selectedFiles.length === 0) {
      return
    }

    const validFiles = []
    selectedFiles.forEach((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!ALLOWED_EXTENSIONS.has(extension)) {
        addToast(`⚠ ${file.name}: only .pdf and .docx are allowed.`, 'error')
        return
      }

      if (file.size > MAX_SIZE_BYTES) {
        addToast(`✖ ${file.name}: file is greater than 2MB.`, 'error')
        return
      }

      validFiles.push({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        name: file.name,
        size: file.size,
        type: file.type,
        file,
        extension,
        isPdf: extension === 'pdf',
        url: URL.createObjectURL(file),
      })
    })

    if (validFiles.length > 0) {
      setAcceptedFiles((currentFiles) => [...currentFiles, ...validFiles])
      setSelectedFileId((currentSelectedId) => {
        if (currentSelectedId) {
          return currentSelectedId
        }

        const firstPdf = validFiles.find((file) => file.isPdf)
        return firstPdf?.id ?? validFiles[0].id
      })
      addToast(`✔ ${validFiles.length} file(s) ready to upload.`, 'success')
    }
  }

  const openFilesPicker = () => {
    filesInputRef.current?.click()
  }

  const onInputChange = (event) => {
    handleSelection(event.target.files)
    event.target.value = ''
  }

  const selectedFile =
    acceptedFiles.find((file) => file.id === selectedFileId) ?? acceptedFiles[0]

  const handleScanSubmit = async (event) => {
    event.preventDefault()
    const query = scanInput.trim()
    if (!query || isScanning) return

    setScanMessages((currentMessages) => [
      ...currentMessages,
      { id: `${Date.now()}-u`, role: 'user', text: query },
    ])
    setScanInput('')

    if (!selectedFile) {
      const reply = 'No file selected.'
      addToast(`⚠ ${reply}`, 'error')
      setScanMessages((currentMessages) => [
        ...currentMessages,
        { id: `${Date.now()}-a`, role: 'assistant', text: reply },
      ])
      return
    }

    if (!selectedFile.isPdf) {
      const reply = 'Highlighting works only for PDF files.'
      addToast(`⚠ ${reply}`, 'error')
      setScanMessages((currentMessages) => [
        ...currentMessages,
        { id: `${Date.now()}-a`, role: 'assistant', text: reply },
      ])
      return
    }

    try {
      setIsScanning(true)
      const { blob, totalMatches, targetWord } = await highlightWordInPdfFile(
        selectedFile.file,
        query,
      )
      const newUrl = URL.createObjectURL(blob)

      setAcceptedFiles((currentFiles) =>
        currentFiles.map((file) =>
          file.id === selectedFile.id
            ? { ...file, url: newUrl, highlightedWord: targetWord, isHighlighted: true }
            : file,
        ),
      )

      const reply =
        totalMatches > 0
          ? `Highlighted ${totalMatches} occurrence(s) of "${targetWord}".`
          : `No occurrences of "${targetWord}" found.`
      addToast(totalMatches > 0 ? `✔ ${reply}` : `⚠ ${reply}`, totalMatches > 0 ? 'success' : 'error')
      setScanMessages((currentMessages) => [
        ...currentMessages,
        { id: `${Date.now()}-a`, role: 'assistant', text: reply },
      ])
    } catch (error) {
      const reply = `Scan failed: ${error.message}`
      addToast(`✖ ${reply}`, 'error')
      setScanMessages((currentMessages) => [
        ...currentMessages,
        { id: `${Date.now()}-a`, role: 'assistant', text: reply },
      ])
    } finally {
      setIsScanning(false)
    }
  }

  return (
    <main className={`app ${acceptedFiles.length > 0 ? 'viewer-mode' : ''}`}>
      {acceptedFiles.length === 0 && (
        <>
          <h1 className="title">Specter</h1>
          <p className="subtitle">AI assisted SOW reviewer with human in loop</p>

          <div className="upload-actions">
            <Button label="Upload" onClick={openFilesPicker} />
          </div>
        </>
      )}

      <input
        ref={filesInputRef}
        className="hidden-input"
        type="file"
        accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        multiple
        onChange={onInputChange}
      />

      {acceptedFiles.length > 0 && (
        <>
          <nav className="viewer-navbar">
            <Button
              label="Scan"
              className="scan-button"
              onClick={() => setIsScanOpen((current) => !current)}
            />
          </nav>

          <section className={`workspace ${isScanOpen ? 'scan-open' : ''}`}>
            <div className="viewer-shell">
              <aside className="file-sidebar">
                <h2 className="file-sidebar-title">Files</h2>
                <ul className="accepted-files">
                  {acceptedFiles.map((file) => (
                    <li key={file.id}>
                      <button
                        type="button"
                        className={`file-item ${selectedFile?.id === file.id ? 'active' : ''}`}
                        onClick={() => setSelectedFileId(file.id)}
                      >
                        <span>{file.isPdf ? '📄' : '📝'}</span>
                        <span>{file.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </aside>
              <div className="viewer-panel">
                {selectedFile?.isPdf ? (
                  <iframe
                    className="pdf-frame"
                    src={selectedFile.url}
                    title={selectedFile.name}
                  />
                ) : (
                  <div className="non-pdf-message">
                    <p>Preview is available for PDF files.</p>
                    <p>
                      Selected: <strong>{selectedFile?.name}</strong>
                    </p>
                  </div>
                )}
              </div>
            </div>

            {isScanOpen ? (
              <aside className="scan-chatbar">
                <h2 className="scan-title">Scan</h2>
                <div className="scan-messages">
                  {scanMessages.length === 0 ? (
                    <p className="scan-empty">Type a word and press Enter. Example: gpu</p>
                  ) : (
                    scanMessages.map((message) => (
                      <p
                        key={message.id}
                        className={`scan-message ${message.role === 'user' ? 'user' : 'assistant'}`}
                      >
                        {message.text}
                      </p>
                    ))
                  )}
                </div>
                <form className="scan-form" onSubmit={handleScanSubmit}>
                  <input
                    className="scan-input"
                    value={scanInput}
                    onChange={(event) => setScanInput(event.target.value)}
                    placeholder="Enter word to highlight"
                    disabled={isScanning}
                  />
                  <button type="submit" className="scan-submit" disabled={isScanning}>
                    {isScanning ? 'Scanning...' : 'Enter'}
                  </button>
                </form>
              </aside>
            ) : null}
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

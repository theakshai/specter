import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function PdfViewer({ file, fileSource, findings, activeFindingId }) {
  const [numPages, setNumPages] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [docxHtml, setDocxHtml] = useState('')
  const [docxError, setDocxError] = useState('')
  const pageRefs = useRef(new Map())

  const quoteFindings = useMemo(
    () =>
      (findings || [])
        .filter((finding) => finding?.quote_text)
        .sort((a, b) => b.quote_text.length - a.quote_text.length),
    [findings],
  )

  const activeFinding = useMemo(
    () => quoteFindings.find((finding) => finding.finding_id === activeFindingId),
    [quoteFindings, activeFindingId],
  )

  useEffect(() => {
    if (!activeFinding) return
    const pageElement = pageRefs.current.get(activeFinding.page_number)
    pageElement?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [activeFinding])

  const isDocxPreview = file?.preview_type === 'docx-html'

  useEffect(() => {
    if (!isDocxPreview || !fileSource?.url) return undefined
    let ignore = false
    startTransition(() => {
      setDocxHtml('')
      setDocxError('')
    })

    fetch(fileSource.url)
      .then((response) => {
        if (!response.ok) {
          throw new Error('Failed to load DOCX preview.')
        }
        return response.text()
      })
      .then((html) => {
        if (!ignore) {
          setDocxHtml(html)
        }
      })
      .catch((error) => {
        if (!ignore) {
          setDocxError(error?.message || 'Failed to load DOCX preview.')
        }
      })

    return () => {
      ignore = true
    }
  }, [isDocxPreview, fileSource?.url])

  const findingsByPage = useMemo(() => {
    const map = new Map()
    quoteFindings.forEach((finding) => {
      const pageList = map.get(finding.page_number) || []
      pageList.push(finding)
      map.set(finding.page_number, pageList)
    })
    return map
  }, [quoteFindings])

  const buildTextRenderer = (pageFindings) => ({ str }) => {
    let rendered = str

    pageFindings.forEach((finding) => {
      const quote = finding.quote_text.trim()
      if (!quote) return
      const pattern = new RegExp(escapeRegExp(quote), 'gi')
      const className =
        finding.finding_id === activeFindingId ? 'pdf-mark active' : 'pdf-mark'
      rendered = rendered.replace(pattern, `<mark class="${className}">$&</mark>`)
    })

    return rendered
  }

  if (isDocxPreview) {
    return (
      <section className="docx-viewer">
        {docxError ? (
          <p className="pdf-status">{docxError}</p>
        ) : docxHtml ? (
          <iframe
            title={file?.name || 'DOCX preview'}
            className="docx-iframe"
            sandbox=""
            srcDoc={docxHtml}
          />
        ) : (
          <p className="pdf-status">Rendering DOCX preview...</p>
        )}
      </section>
    )
  }

  if (!fileSource?.url) {
    return <p className="pdf-status">No preview available.</p>
  }

  return (
    <Document
      file={fileSource?.url || null}
      className="pdf-document"
      onLoadSuccess={({ numPages: loadedPages }) => {
        setNumPages(loadedPages)
        setLoadError('')
      }}
      onLoadError={(error) => setLoadError(error?.message || 'Failed to load PDF.')}
      loading={<p className="pdf-status">Loading PDF...</p>}
      error={<p className="pdf-status">{loadError || 'Failed to load PDF.'}</p>}
    >
      {Array.from({ length: numPages }, (_, index) => {
        const pageNumber = index + 1
        const pageFindings = findingsByPage.get(pageNumber) || []
        const hasMarks = pageFindings.length > 0

        return (
          <div
            key={`page-wrap-${pageNumber}`}
            ref={(element) => {
              if (element) pageRefs.current.set(pageNumber, element)
            }}
            className="pdf-page-wrap"
          >
            <Page
              key={`page-${pageNumber}`}
              pageNumber={pageNumber}
              renderTextLayer={hasMarks}
              renderAnnotationLayer={false}
              customTextRenderer={hasMarks ? buildTextRenderer(pageFindings) : undefined}
              className="pdf-page"
              width={900}
            />
          </div>
        )
      })}
    </Document>
  )
}

export default PdfViewer

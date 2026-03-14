import { useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function PdfViewer({ fileSource, findings, activeFindingId }) {
  const [numPages, setNumPages] = useState(0)
  const [loadError, setLoadError] = useState('')
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

  const customTextRenderer = ({ str }) => {
    let rendered = str

    quoteFindings.forEach((finding) => {
      const quote = finding.quote_text.trim()
      if (!quote) return
      const pattern = new RegExp(escapeRegExp(quote), 'gi')
      const className =
        finding.finding_id === activeFindingId ? 'pdf-mark active' : 'pdf-mark'
      rendered = rendered.replace(pattern, `<mark class="${className}">$&</mark>`)
    })

    return rendered
  }

  return (
    <Document
      file={fileSource}
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
              renderTextLayer
              renderAnnotationLayer={false}
              customTextRenderer={customTextRenderer}
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

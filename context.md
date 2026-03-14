# Context

- 2026-03-14: Created React app `specter/` with Vite.
- 2026-03-14: Installed dependencies with Bun.
- 2026-03-14: Simplified app UI and enforced theme:
  - Font: Roboto Mono
  - Colors: mercury white (`#f4f5f8`) and nordic grey (`#222326`)
- 2026-03-14: Swapped theme usage:
  - Background: nordic grey
  - Text: mercury white
- 2026-03-14: Updated exact palette values:
  - mercury white: `#f4f5f8`
  - nordic grey: `#222326`
- 2026-03-14: Added `components/Button.jsx` and updated hero section:
  - Centered large orange `Specter` title with slow-appear animation
  - Subtitle: "AI assisted SOW reviewer with human in loop"
  - Center button label: "Get Started"
- 2026-03-14: Switched global font setup to Google Fonts Datatype:
  - Added preconnect + stylesheet links in `specter/index.html`
  - Applied `font-family: 'Datatype', monospace` with optical sizing and width variation
- 2026-03-14: Updated typography scope:
  - `Specter` title: Datatype, bold
  - Other text: Poppins, normal (400)
- 2026-03-14: Added upload validation workflow:
  - Upload options for files or directory
  - Only `.pdf` and `.docx` allowed
  - Per-file 2MB max check with toast errors for each oversized file
  - Success/error toasts and accepted-file list UI
- 2026-03-14: Added PDF-viewer-like workspace:
  - After upload, shows a center preview panel
  - With multiple files, first PDF is selected by default and file list is shown in sidebar
  - Clicking a file in sidebar switches the center view
- 2026-03-14: Added static post-upload navbar:
  - Navbar appears only after at least one file is uploaded
  - Includes one button: `Scan`
- 2026-03-14: Added Scan chatbar + in-app PDF word highlighter:
  - `Scan` toggles a right-side chatbar
  - Entering a term (e.g. `gpu`) and pressing Enter runs highlight logic equivalent to `highlight-word.js`
  - Selected PDF is updated in viewer with highlighted output
- 2026-03-14: Added Safari-only scan fallback method:
  - Safari uses `pdfjs-dist-v4` path for scan/highlight
  - Other browsers continue using `pdfjs-dist` v5 method
- 2026-03-14: Implemented v1 SOW batch review architecture.
  - Added backend API server (`specter/server/index.js`) with:
    - review batch creation, file upload, run/poll status, findings fetch, finding status updates
    - rule template CRUD
    - async queue + per-file processing states
    - 24h data cleanup for uploaded files and in-memory records
  - Added chunked multi-pass PDF analysis pipeline with:
    - page extraction via `pdfjs-dist`
    - optional OpenAI call when `OPENAI_API_KEY` is set
    - heuristic fallback analyzer
    - finding schema + deduplication
  - Rebuilt frontend workflow for Batch Then Review:
    - upload 1-5 PDFs, run review, file-level status pills
    - left file list + center PDF viewer + right findings panel
    - rule template selector/editor + save + run actions
    - finding actions: Accept / Dismiss / Needs Follow-up
    - overlay highlights in viewer from returned findings and page jump on selection
  - Added Vite API proxy and scripts (`server`, `dev:full`).
  - Added dependencies: `express`, `multer`, `cors`, `react-pdf`; pinned `pdfjs-dist` to `5.4.296`.

## Session Handoff (2026-03-14)

### Current Product State
- V1 SOW reviewer implemented in `specter/` as frontend + backend.
- Frontend: upload PDFs, run batch review, status polling, sidebar file selection, center PDF preview, right findings panel with actions.
- Backend: async queue, per-file processing states, rule template CRUD, findings APIs, 24h cleanup.

### Working Run Commands
- Backend API: `cd /Users/akshai/personal/specter/specter && bun run server`
- Frontend: `cd /Users/akshai/personal/specter/specter && bun run dev`
- Lint: `bun run lint`
- Build: `bun run build`

### Key Files
- Backend API + processing: `specter/server/index.js`
- Main UI workflow: `specter/src/App.jsx`
- Styling/layout: `specter/src/App.css`
- PDF viewer + highlight overlay: `specter/src/components/PdfViewer.jsx`
- Vite proxy: `specter/vite.config.js`
- Scripts/deps: `specter/package.json`

### API Surface Implemented
- `POST /api/review-batches`
- `POST /api/review-batches/:batchId/files`
- `GET /api/review-batches/:batchId/status`
- `POST /api/review-batches/:batchId/run`
- `GET /api/review-batches/:batchId/files/:fileId/findings`
- `PATCH /api/review-batches/:batchId/files/:fileId/findings/:findingId`
- `GET /api/rule-templates`
- `POST /api/rule-templates`
- `PATCH /api/rule-templates/:templateId`
- `GET /api/files/:storageId/content`

### Fallback Analyzer Notes
- Fallback path is active when `OPENAI_API_KEY` is not set.
- Rule parsing now supports:
  - `Flag lines with the word GPU`
  - `word gpu`
  - `missing ...` / `ambiguous ...` patterns
- Keyword matching is case-insensitive.

### OpenAI Path
- If `OPENAI_API_KEY` is set, backend attempts AI analysis first per chunk.
- On AI failure/empty parse, it falls back to heuristic analyzer.
- Optional env: `OPENAI_MODEL` (default: `gpt-4.1-mini`).

### Known Constraints / Gaps
- Upload endpoint currently accepts only PDF for analysis in backend.
- Findings highlight is text-overlay in viewer (not burned into output PDF).
- No persistent DB yet (in-memory metadata + file storage under `.runtime/uploads`).

### High-Value Next Steps
1. Add explicit `engine_used: ai|fallback` per file in status/findings responses.
2. Add true page-jump and active-finding scroll precision in PDF viewer.
3. Add batch summary export (CSV/JSON of findings).
4. Move metadata to persistent DB (SQLite/Postgres) if multi-session retention is needed.
5. Add auth/project scoping before multi-user usage.

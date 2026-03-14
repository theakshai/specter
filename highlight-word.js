#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { PDFDocument, rgb } = require('pdf-lib');

const INPUT_FILE = 'gpu.pdf';
const OUTPUT_FILE = 'gpu-yellow.pdf';
const HIGHLIGHT_STYLE = Object.freeze({
  color: rgb(1, 1, 0),
  opacity: 0.45,
  borderWidth: 0,
});

const loadPdfJs = async () => import('pdfjs-dist/legacy/build/pdf.mjs');

const normalizeWord = (value) => value.trim().toLowerCase();

const getWordFromPrompt = async () => {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const raw = await rl.question('Enter the word to highlight: ');
    return normalizeWord(raw);
  } finally {
    rl.close();
  }
};

const findOccurrences = (haystack, needle) => {
  if (!needle) return [];
  const starts = [];
  let start = 0;

  while (start < haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    starts.push(index);
    start = index + needle.length;
  }
  return starts;
};

const isSearchableTextItem = (item) => Boolean(item?.str?.trim());

const getItemGeometry = (item) => {
  const width = Math.abs(item.width || 0);
  const derivedHeight = Math.hypot(item.transform[2], item.transform[3]);
  const height = Math.abs(item.height || derivedHeight || 10);
  if (!width || !height) return null;

  return {
    width,
    height,
    x: item.transform[4],
    y: item.transform[5],
  };
};

const buildRectanglesForItem = (item, targetWord) => {
  if (!isSearchableTextItem(item)) return [];

  const starts = findOccurrences(item.str.toLowerCase(), targetWord);
  if (starts.length === 0) return [];

  const geometry = getItemGeometry(item);
  if (!geometry) return [];

  const charWidth = geometry.width / item.str.length;
  return starts.map((start) => ({
    x: geometry.x + charWidth * start,
    y: geometry.y - geometry.height * 0.2,
    width: charWidth * targetWord.length,
    height: geometry.height * 1.1,
  }));
};

const buildPageRectangles = (textItems, targetWord) =>
  textItems.flatMap((item) => buildRectanglesForItem(item, targetWord));

const drawRectangles = (pdfPage, rectangles) =>
  rectangles.forEach((rectangle) => pdfPage.drawRectangle({ ...rectangle, ...HIGHLIGHT_STYLE }));

const openPdfResources = async (pdfBytes) => {
  const [pdfDoc, pdfjs] = await Promise.all([PDFDocument.load(pdfBytes), loadPdfJs()]);
  const sourcePdf = await pdfjs
    .getDocument({ data: new Uint8Array(pdfBytes), disableWorker: true })
    .promise;
  return { pdfDoc, sourcePdf };
};

const processPage = async ({ pageNumber, sourcePdf, pdfDoc, targetWord }) => {
  const sourcePage = await sourcePdf.getPage(pageNumber);
  sourcePage.getViewport({ scale: 1, dontFlip: true });

  const textContent = await sourcePage.getTextContent({ normalizeWhitespace: true });
  const rectangles = buildPageRectangles(textContent.items, targetWord);

  const drawPage = pdfDoc.getPage(pageNumber - 1);
  drawRectangles(drawPage, rectangles);
  return rectangles.length;
};

const highlightWordInPdf = async ({ inputPath, outputPath, targetWord }) => {
  const pdfBytes = await fs.readFile(inputPath);
  const { pdfDoc, sourcePdf } = await openPdfResources(pdfBytes);

  const pageNumbers = Array.from({ length: sourcePdf.numPages }, (_, i) => i + 1);
  const perPageMatches = await Promise.all(
    pageNumbers.map((pageNumber) =>
      processPage({ pageNumber, sourcePdf, pdfDoc, targetWord })
    )
  );
  const totalMatches = perPageMatches.reduce((sum, count) => sum + count, 0);

  const outputBytes = await pdfDoc.save();
  await fs.writeFile(outputPath, outputBytes);
  return totalMatches;
};

async function main() {
  const inputPath = path.resolve(process.cwd(), INPUT_FILE);
  const outputPath = path.resolve(process.cwd(), OUTPUT_FILE);
  const targetWord = await getWordFromPrompt();

  if (!targetWord) {
    throw new Error('No word entered.');
  }

  const totalMatches = await highlightWordInPdf({ inputPath, outputPath, targetWord });

  if (totalMatches === 0) {
    console.log(`No occurrences of "${targetWord}" were found. Saved unchanged file to: ${outputPath}`);
    return;
  }

  console.log(`Highlighted ${totalMatches} occurrence(s) of "${targetWord}".`);
  console.log(`Saved: ${outputPath}`);
}

main().catch((error) => {
  console.error(`Failed to process PDF: ${error.message}`);
  process.exit(1);
});

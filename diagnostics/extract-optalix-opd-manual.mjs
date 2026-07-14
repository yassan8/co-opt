import fs from 'node:fs/promises';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('PDF path is required');
const bytes = new Uint8Array(await fs.readFile(inputPath));
const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
const matches = [];
for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  const text = content.items.map((item) => item.str).join(' ').replace(/\s+/g, ' ');
  if (/ROPD|OPD\s*\(\s*Field|single ray.{0,80}optical path|optical path difference.{0,100}chief/i.test(text)) {
    const terms = [...text.matchAll(/ROPD|OPD\s*\(\s*Field|single ray.{0,80}optical path|optical path difference.{0,100}chief/ig)];
    for (const match of terms) {
      const start = Math.max(0, match.index - 700);
      const end = Math.min(text.length, match.index + match[0].length + 1200);
      matches.push({ page: pageNumber, text: text.slice(start, end) });
    }
  }
}
console.log(JSON.stringify(matches, null, 2));

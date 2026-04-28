(async () => {
class DOMMatrix {
  constructor() {
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
  }
}
globalThis.DOMMatrix = DOMMatrix;

const fs = await import('fs');
const path = await import('path');
const pdfjs = await import('./node_modules/pdfjs-dist/build/pdf.mjs');

// Skip setting workerSrc, let pdf.mjs handle it or fail gracefully
// pdfjs.GlobalWorkerOptions.workerSrc = path.resolve('./node_modules/pdfjs-dist/build/pdf.worker.mjs');

async function run() {
  const filePath = '/Users/masanori/Downloads/JPA 1999072704-000000.pdf';
  const data = new Uint8Array(fs.readFileSync(filePath));
  const loadingTask = pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    useSystemFonts: true,
    isEvalSupported: false,
    disableRange: true,
    disableStream: true
  });
  const pdf = await loadingTask.promise;
  console.log('Page count:', pdf.numPages);

  const targets = ['非球面係数', '第１面(r1)', 'A4=', 'ε='];
  let found = false;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str).join(' ');
    
    for (const target of targets) {
      if (text.includes(target)) {
        console.log(`Match found for "${target}" on page ${i}`);
        const idx = text.indexOf(target);
        const start = Math.max(0, idx - 50);
        const end = Math.min(text.length, idx + 100);
        console.log(`Excerpt: ...${text.substring(start, end)}...`);
        found = true;
      }
    }
  }

  if (!found) {
    console.log('No matches found for any target strings.');
  }
}

await run();
})().catch(err => {
  console.error(err);
  process.exit(1);
});

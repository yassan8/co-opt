import { useEffect, useRef, useState } from 'react';

type LiteratureExtractResult = {
  patentIds: string[];
  sourceUrls: string[];
  focalLengths: number[];
  fNumbers: number[];
  fieldAngles: number[];
  imageHeights: number[];
  totalLengths: number[];
  glassNames: string[];
  embodiments: LiteratureOption[];
  zoomPositions: LiteratureOption[];
  candidateTableRows: LiteratureCandidateRow[];
};

type LiteratureOption = {
  key: string;
  label: string;
  zoomIndex?: number | null;
};

type LiteratureCandidateRow = {
  line: string;
  numbers: number[];
  embodimentKey: string;
  embodimentLabel: string;
  zoomKey: string;
  zoomLabel: string;
  surfaceIndex?: number | null;
};

type DraftBuildResult = {
  rows: Array<Record<string, any>>;
  notes: string[];
};

type PatentAsphereTerms = {
  hasAny: boolean;
  conic: number | null;
  surfType: 'Aspheric even' | 'Aspheric odd' | 'Qcon' | null;
  coefficients: Record<number, number>;
};

const LITERATURE_IMPORT_EXAMPLE = [
  'JP2024-123456 A Zoom lens',
  'f = 24 50 72',
  'Fno = 2.8 4.0 5.6',
  'Half angle = 38.2 22.4 15.1',
  'TL = 118.5',
  'G1   34.12  -28.45   4.20   N-BK7   64.17',
  'G2  -41.55   96.30   1.80   N-SF10  28.41',
  'Air  INF     INF    12.60',
].join('\n');

const PATENT_OCR_REPLACEMENTS: Array<[RegExp, string]> = [
  [/^\s*r[Il|l][sS](?=\s*[#%*¥]?\s*=)/gim, 'r1'],
  [/\br[Il|l]{2}(?=\s*[#%*¥]?\s*=)/g, 'r11'],
  [/^\s*[Tt]\s*r\s*(\d{1,2})\s*[#%*¥]?\s*=\s*/gim, 'r$1='],
  [/^\s*[Tt][Il|l]?(\d{1,2})\s*[#%*¥]?\s*=\s*/gim, 'r$1='],
  [/\br[Il|](?=\s*[#%*¥]?\s*=)/g, 'r1'],
  [/\bd[Il|](?=\s*[#%*¥]?\s*=)/g, 'd1'],
  [/\bv[Il|](?=\s*[#%*¥]?\s*=)/g, 'v1'],
  [/\bN[Il|](?=\s*[#%*¥]?\s*=)/g, 'N1'],
  [/\brl(?=\d)/g, 'r1'],
  [/\bdl(?=\d)/g, 'd1'],
  [/\bvl(?=\d)/g, 'v1'],
  [/\bNl(?=\d)/g, 'N1'],
  [/\br1(1[0-7])(?=\s*[#%*¥]?\s*=|\))/g, 'r$1'],
  [/\bM[Il](?=\s*=|\s*[-:]\s*(?=\d))/g, 'N1'],
  [/\bM(\d+)\s*[-:]\s*(?=\d)/g, 'N$1='],
  [/\br(\d+)%\s*=/gi, 'r$1='],
  [/\br(\d+)[#*¥]\s*=/gi, 'r$1='],
  [/\bd(\d+)%\s*=/gi, 'd$1='],
  [/\bd(\d+)[#*¥]\s*=/gi, 'd$1='],
  [/\bv(\d+)%\s*=/gi, 'v$1='],
  [/^\s*([1-9]\d?)\s*[#%*¥]\s+(?=[+\-]?\d)/gm, 'r$1= '],
  [/^\s*(\d{1,2})\s*=\s*(?=-)/gm, 'r$1='],
  [/^\s*[39](\d{1,2})\s*[-=]\s*(?=[+\-]?\d)/gm, 'd$1='],
  [/^\s*4(1[0-7]|[1-9])\s*[-=]\s*(?=[+\-]?\d)/gm, 'd$1='],
  [/^\s*(1[0-7]|[1-9])(?=\d\.\d+\s*[~〜へ])/gm, 'd$1='],
  [/^\s*(1[0-7]|[1-9])\s+(?=[+\-]?\d+(?:\.\d+)?\s*[~〜へ])/gm, 'd$1= '],
  [/\bN(\d+)\s*[-:]\s*=?\s*(?=\d)/g, 'N$1='],
  [/(^|\s)0(?=\d{1,2}\s*=)/gm, '$1d'],
  [/(^|\s)O(?=\d{1,2}\s*=)/gm, '$1d'],
  [/^(\d{1,2})\s*=(?=\s*[+\-]?\d)/gm, 'd$1='],
  [/([εϵ∈])\s*=/g, 'epsilon='],
  [/\b[Oo](?=\d+(?:\.\d+)?\b)/g, '0'],
  [/\bINF\s+INF\b/g, 'INF d='],
  [/^\s*18\s*--\s*(?=[+\-]?\d)/gim, 'A18='],
];

const PATENT_NUMBER_SOURCE = '[+\\-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+\\-]?\\d+)?';
const PATENT_ISOLATED_NUMBER_PATTERN = new RegExp(`(?:^|[^A-Za-z0-9_.])(${PATENT_NUMBER_SOURCE})(?=$|[^A-Za-z0-9_.])`, 'gi');

const PDFJS_CMAP_ASSET_MODULES = {
  ...import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/Adobe-Japan1-*.bcmap', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/UniJIS*.bcmap', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/*RKSJ*.bcmap', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/Hankaku.bcmap', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/Hiragana.bcmap', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/Katakana.bcmap', { query: '?url', import: 'default', eager: true }),
  ...import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/Roman.bcmap', { query: '?url', import: 'default', eager: true }),
};

const PDFJS_STANDARD_FONT_ASSET_MODULES = import.meta.glob('../../../node_modules/pdfjs-dist/standard_fonts/*', { query: '?url', import: 'default', eager: true });

function buildPdfJsAssetUrlMap(modules: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [filePath, assetUrl] of Object.entries(modules ?? {})) {
    const fileName = String(filePath.split('/').pop() ?? '').trim();
    const resolvedUrl = String(assetUrl ?? '').trim();
    if (!fileName || !resolvedUrl) continue;
    result[fileName] = resolvedUrl;
  }
  return result;
}

const PDFJS_CMAP_ASSET_URLS = buildPdfJsAssetUrlMap(PDFJS_CMAP_ASSET_MODULES as Record<string, unknown>);
const PDFJS_STANDARD_FONT_ASSET_URLS = buildPdfJsAssetUrlMap(PDFJS_STANDARD_FONT_ASSET_MODULES as Record<string, unknown>);

class PdfJsBinaryDataFactory {
  constructor(_options?: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {}

  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const assetMap = kind === 'cMapUrl'
      ? PDFJS_CMAP_ASSET_URLS
      : kind === 'standardFontDataUrl'
        ? PDFJS_STANDARD_FONT_ASSET_URLS
        : null;
    const assetUrl = assetMap ? String(assetMap[String(filename ?? '').trim()] ?? '').trim() : '';
    if (!assetUrl) {
      throw new Error(`Missing PDF.js asset for ${kind}:${filename}`);
    }
    const response = await fetch(assetUrl);
    if (!response.ok) {
      throw new Error(`Failed to load PDF.js asset ${filename}: ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawValue of values) {
    const value = String(rawValue ?? '').trim();
    if (!value) continue;
    const key = value.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function uniqueNumbers(values: number[], digits = 6): number[] {
  const seen = new Set<string>();
  const result: number[] = [];
  for (const rawValue of values) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const key = value.toFixed(digits);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function collectMatches(text: string, pattern: RegExp, transform?: (value: string) => string): string[] {
  const result: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = transform ? transform(match[0]) : match[0];
    if (value) result.push(value);
  }
  pattern.lastIndex = 0;
  return uniqueStrings(result);
}

function collectNumericGroups(text: string, pattern: RegExp): number[] {
  const result: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    for (let index = 1; index < match.length; index += 1) {
      const value = Number(match[index]);
      if (Number.isFinite(value)) result.push(value);
    }
  }
  pattern.lastIndex = 0;
  return uniqueNumbers(result);
}

function normalizePatentOcrText(input: string): string {
  let text = String(input ?? '')
    .replace(/[\u3000\t]+/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[，]/g, ',')
    .replace(new RegExp(`(${PATENT_NUMBER_SOURCE})\\s*[×xX*]\\s*10\\s*\\^?\\s*([+\\-]?\\d+)`, 'gi'), '$1e$2')
    .replace(new RegExp(`(${PATENT_NUMBER_SOURCE})\\s*[×xX*]\\s*10\\s*[”″〃]+`, 'gi'), '$1e-4')
    .replace(new RegExp(`(${PATENT_NUMBER_SOURCE})\\s*[×xX*]\\s*10\\s*['’\\x60]+`, 'gi'), '$1e-5')
    .replace(/(\d),(\d)/g, '$1.$2')
    .replace(/(\d)\.\s+(\d)/g, '$1.$2')
    .replace(/([+\-]?\d)\s+\.\s+(\d)/g, '$1.$2')
    .replace(/([+\-])\s+(\d)/g, '$1$2')
    .replace(/(\d)[Oo](?=\d|\.)/g, (_match, digit) => `${digit}0`)
    .replace(/\b[Oo](?=\d|\.\d)/g, '0')
    .replace(/\b[Il](?=\d{2,}\b)/g, '1');

  for (const [pattern, replacement] of PATENT_OCR_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  return text.replace(/\s{2,}/g, ' ');
}

function isInfLikePatentImport(value: any): boolean {
  if (value === Infinity) return true;
  const text = String(value ?? '').trim().toUpperCase();
  return text === 'INF' || text === 'INFINITY' || text === '∞';
}

function isVariableLikePatentImport(value: any): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /^可変$/i.test(text) || /^var(?:iable)?$/i.test(text);
}

function extractPatentNumbers(text: string): number[] {
  const result: number[] = [];
  const sourceText = String(text ?? '');
  let match: RegExpExecArray | null;
  while ((match = PATENT_ISOLATED_NUMBER_PATTERN.exec(sourceText)) !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) result.push(value);
  }
  PATENT_ISOLATED_NUMBER_PATTERN.lastIndex = 0;
  return result;
}

function extractPatentSurfaceIndexHint(line: string): number | null {
  const text = String(line ?? '').trim();
  if (!text) return null;

  const explicitRadiusMatch = text.match(/\br\s*(\d+)\b/i);
  if (explicitRadiusMatch) {
    const value = Number(explicitRadiusMatch[1]);
    return Number.isInteger(value) ? value : null;
  }

  const explicitThicknessMatch = text.match(/\bd\s*(\d+)\b/i);
  if (explicitThicknessMatch) {
    const value = Number(explicitThicknessMatch[1]);
    return Number.isInteger(value) ? value : null;
  }

  const surfaceHeaderMatch = text.match(/第\s*([0-9]+)\s*面.*\(\s*r?\s*(\d+)\s*\)/i)
    || text.match(/\(\s*r?\s*(\d+)\s*\).*第\s*([0-9]+)\s*面/i);
  if (surfaceHeaderMatch) {
    const value = Number(surfaceHeaderMatch[2] ?? surfaceHeaderMatch[1]);
    return Number.isInteger(value) ? value : null;
  }

  const plainSurfaceHeaderMatch = text.match(/第\s*([0-9]+)\s*面/i);
  if (plainSurfaceHeaderMatch) {
    const value = Number(plainSurfaceHeaderMatch[1]);
    return Number.isInteger(value) ? value : null;
  }

  const englishSurfaceMatch = text.match(/(?:surface|surf\.?|面)\s*([0-9]{1,2})\b/i)
    || text.match(/\b([0-9]{1,2})(?:st|nd|rd|th)\s*(?:surface|surf\.?)\b/i)
    || text.match(/\bS\s*([0-9]{1,2})\b/i);
  if (englishSurfaceMatch) {
    const value = Number(englishSurfaceMatch[1]);
    return Number.isInteger(value) ? value : null;
  }

  return null;
}

function collectPatentAiSourceExcerpts(sourceText: string): string {
  const source = String(sourceText ?? '').trim();
  if (!source) return '';
  if (source.length <= 20000) return source;

  const markerPattern = /非\s*球面\s*(?:データ|係数)|非\s*球面|円錐定数|コーニック定数|コニック定数|円すい定数|2次曲面パラメータ|二次曲面パラメータ|aspheric|asphere|conic|epsilon|\bK\s*[=:]|\b[A-D]\s*(?:4|6|8|10|12|14|16|18|20)\s*[=:\-]/gi;
  const windows: Array<{ start: number; end: number }> = [{ start: 0, end: Math.min(9000, source.length) }];
  for (const match of source.matchAll(markerPattern)) {
    const index = Number(match.index ?? -1);
    if (!Number.isInteger(index) || index < 0) continue;
    windows.push({
      start: Math.max(0, index - 3500),
      end: Math.min(source.length, index + 6500),
    });
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const window of windows.sort((left, right) => left.start - right.start)) {
    const prev = merged[merged.length - 1];
    if (prev && window.start <= prev.end + 500) {
      prev.end = Math.max(prev.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }

  const parts: string[] = [];
  let total = 0;
  for (const window of merged) {
    if (total >= 26000) break;
    const excerpt = source.slice(window.start, window.end).trim();
    if (!excerpt) continue;
    parts.push(`[source chars ${window.start}-${window.end}]\n${excerpt}`);
    total += excerpt.length;
  }
  return parts.join('\n\n---\n\n');
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read image'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToGeminiInlineData(dataUrl: string, fallbackMimeType = 'image/png'): { mimeType: string; data: string } {
  const match = String(dataUrl || '').match(/^data:([^;,]+);base64,(.*)$/);
  if (match) {
    return {
      mimeType: String(match[1] || fallbackMimeType),
      data: String(match[2] || ''),
    };
  }
  return {
    mimeType: fallbackMimeType,
    data: String(dataUrl || '').replace(/^data:[^,]*,/, ''),
  };
}

function normalizePatentAsphereLine(line: string): string {
  return String(line ?? '')
    .replace(/^\s*\[[^\]]+\]\s*/g, '')
    .replace(/^\s*(?:【\s*0*\d+\s*】|\[\s*0*\d+\s*\])\s*/g, '')
    .replace(/^\s*\d+\s+(?=A[dD]\s*[:=\-])/i, '')
    .replace(/\bAd(?=\s*[:=\-])/gi, 'A4')
    .replace(/\bA([Il|])\s*([0-9])/g, 'A1$2')
    .replace(/\bAL\s*([0-9])/gi, 'A1$1')
    .replace(/\bA\s*([0-9]{1,2})\s*--\s*/gi, 'A$1=-')
    .replace(/\bA\s*([0-9]{1,2})\s*[-ー]\s*(?=[+\-]?\d)/gi, 'A$1=')
    .replace(/\b[BCD]\s*(4|6|8|10|12|14|16|18|20)\s*(?=[:=\-])/gi, 'A$1')
    .replace(/^\s*M(?=\s*[:=]\s*[+\-]?\d)/i, 'A4')
    .replace(/\bM(?=\s*[:=]\s*[+\-]?\d+(?:\.\d+)?\s*[x×X*]\s*10)/g, 'A4')
    .replace(/^[&gq](?=\s*[:=]\s*[+\-]?\d)/i, 'epsilon')
    .replace(/\bx\s*10\s*[”″〃]+/g, 'e-4')
    .replace(/\bx\s*10\s*['’`]+/g, 'e-5')
    .replace(/\bx\s*10\s*\*/g, 'e-6');
}

function isLikelyCorruptedPatentAsphereValue(rawText: string, value: number): boolean {
  if (!Number.isFinite(value)) return true;

  const raw = String(rawText ?? '').trim();
  if (!raw) return true;

  const normalized = raw
    .replace(/\s+/g, '')
    .replace(/[”″〃]/g, '')
    .replace(/[’'`]/g, '');

  const hasExplicitExponent = /e[+\-]?\d+/i.test(normalized) || /(?:x|×|\*)10/i.test(raw);
  const hasDecimalPoint = normalized.includes('.');
  const digitCount = (normalized.match(/\d/g) ?? []).length;
  const absoluteValue = Math.abs(value);

  if (!hasExplicitExponent && !hasDecimalPoint && digitCount >= 6) return true;
  if (!hasExplicitExponent && absoluteValue >= 1e4) return true;
  if (absoluteValue >= 1e8) return true;
  return false;
}

function normalizePatentAsphereHeaderText(text: string): string {
  return String(text ?? '')
    .replace(/【\s*0*(\d+)\s*】\s*/g, '')
    .replace(/\[\s*/g, '[')
    .replace(/\s*\]/g, ']')
    .replace(/第\s*(\d+)\s*面\s*\(?\s*[gG6]?\s*(\d+)\s*\)?/g, (_match, surfaceText, parenText) => {
      const surface = Number(surfaceText);
      const paren = Number(parenText);
      const resolved = Number.isInteger(paren) ? paren : surface;
      return `第${surface}面(${resolved})`;
    })
    .replace(/\s*の\s*非\s*球面\s*(?:係数|データ)/g, 'の非球面係数')
    .replace(/\s+/g, ' ')
    .trim();
}

function isPatentNoiseLine(line: string): boolean {
  const text = String(line ?? '').trim();
  if (!text) return true;
  if (/^g[0o]?2b\s*\d+/i.test(text)) return true;
  if (/特許|請求項|発明|課題|作用|効果|手段/.test(text) && !/(?:r\s*\d+|d\s*\d+|n\s*\d+|v\s*\d+|epsilon|[εϵ]|\bA\s*(?:4|6|8|10|12|14|16|18|20|22)\s*=)/i.test(text)) {
    return true;
  }
  if (/[ぁ-んァ-ン一-龯]/.test(text) && /(?:である|有する|方向|高さ|パワ)/.test(text)) return true;
  return false;
}

function parsePatentAsphereTerms(line: string): PatentAsphereTerms {
  const text = normalizePatentAsphereLine(line);
  const coefficients: Record<number, number> = {};
  let surfType: PatentAsphereTerms['surfType'] = null;

  let conic: number | null = null;
  const conicPatterns = [
    new RegExp(`(?:^|[^A-Z0-9])(?:conic\\s*constant|conic|cc|k)\\s*[:=]?\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
    new RegExp(`\\bK\\s*=\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
    new RegExp(`(?:^|[^A-Z0-9])(?:epsilon|ε|ϵ|2次曲面パラメータ|二次曲面パラメータ)\\s*[:=：]?\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
    new RegExp(`^\\s*(?:&|g|q)\\s*[:=]\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
    new RegExp(`(?:円錐定数|コーニック定数|コニック定数|円すい定数)\\s*[:=：]?\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
  ];
  for (const pattern of conicPatterns) {
    const match = text.match(pattern);
    const value = Number(match?.[1]);
    if (Number.isFinite(value)) {
      conic = value;
      break;
    }
  }

  const orderPattern = new RegExp(`\\bA\\s*(3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22)\\s*[:=]?\\s*(${PATENT_NUMBER_SOURCE})`, 'gi');
  for (const match of text.matchAll(orderPattern)) {
    const order = Number(match[1]);
    const rawValue = String(match[2] ?? '');
    const value = Number(rawValue);
    if (!Number.isFinite(order) || !Number.isFinite(value)) continue;
    if (isLikelyCorruptedPatentAsphereValue(rawValue, value)) continue;
    if (order >= 4 && order <= 22 && order % 2 === 0) {
      coefficients[(order - 2) / 2] = value;
      surfType = surfType === 'Aspheric odd' ? surfType : 'Aspheric even';
      continue;
    }
    if (order >= 3 && order <= 21 && order % 2 === 1) {
      coefficients[(order - 1) / 2] = value;
      surfType = 'Aspheric odd';
    }
  }

  const relaxedOrderPattern = new RegExp(`\\bA\\s*([Il|1]?\\s*(?:3|4|5|6|7|8|9)|[12Il|]\\s*(?:0|1|2|3|4|5|6|7|8|9)|[dD])\\s*(?:[:=]|=-)?\\s*(${PATENT_NUMBER_SOURCE})`, 'gi');
  for (const match of text.matchAll(relaxedOrderPattern)) {
    const normalizedOrderText = String(match[1] ?? '')
      .replace(/[Il|]/g, '1')
      .replace(/[dD]/g, '4')
      .replace(/\\s+/g, '');
    const order = Number(normalizedOrderText);
    const rawValue = String(match[2] ?? '');
    const value = Number(rawValue);
    if (!Number.isFinite(order) || !Number.isFinite(value)) continue;
    if (isLikelyCorruptedPatentAsphereValue(rawValue, value)) continue;
    if (order >= 4 && order <= 22 && order % 2 === 0) {
      coefficients[(order - 2) / 2] = value;
      surfType = surfType === 'Aspheric odd' ? surfType : 'Aspheric even';
      continue;
    }
    if (order >= 3 && order <= 21 && order % 2 === 1) {
      coefficients[(order - 1) / 2] = value;
      surfType = 'Aspheric odd';
    }
  }

  const coefPattern = new RegExp(`\\bcoef\\s*(10|[1-9])\\s*[:=]?\\s*(${PATENT_NUMBER_SOURCE})`, 'gi');
  for (const match of text.matchAll(coefPattern)) {
    const index = Number(match[1]);
    const value = Number(match[2]);
    if (!Number.isFinite(index) || !Number.isFinite(value) || index < 1 || index > 10) continue;
    coefficients[index] = value;
    if (!surfType) surfType = 'Aspheric even';
  }

  const japaneseOrderPattern = new RegExp(`(?:非球面係数|非球面\\s*係数|係数)\\s*A?\\s*(3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22)\\s*[:=：]?\\s*(${PATENT_NUMBER_SOURCE})`, 'gi');
  for (const match of text.matchAll(japaneseOrderPattern)) {
    const order = Number(match[1]);
    const rawValue = String(match[2] ?? '');
    const value = Number(rawValue);
    if (!Number.isFinite(order) || !Number.isFinite(value)) continue;
    if (isLikelyCorruptedPatentAsphereValue(rawValue, value)) continue;
    if (order >= 4 && order <= 22 && order % 2 === 0) {
      coefficients[(order - 2) / 2] = value;
      surfType = surfType === 'Aspheric odd' ? surfType : 'Aspheric even';
      continue;
    }
    if (order >= 3 && order <= 21 && order % 2 === 1) {
      coefficients[(order - 1) / 2] = value;
      surfType = 'Aspheric odd';
    }
  }

  return {
    hasAny: conic !== null || Object.keys(coefficients).length > 0,
    conic,
    surfType,
    coefficients,
  };
}

function textContainsPatentAsphereMarkers(text: string): boolean {
  const source = String(text ?? '');
  if (!source.trim()) return false;
  return /非球面係数|非球面|円錐定数|コーニック定数|コニック定数|円すい定数|2次曲面パラメータ|二次曲面パラメータ|(?:^|\s)[εϵ]\s*[:=]|\bepsilon\s*[:=]|\bA\s*(?:4|6|8|10|12|14|16|18|20|22)\s*[:=]/im.test(source);
}

function textContainsPatentRadiusMarkers(text: string): boolean {
  const source = normalizePatentOcrText(String(text ?? ''));
  if (!source.trim()) return false;
  return /\br\s*\d+\s*[#%*¥]?\s*=/i.test(source);
}

function textLooksLikePatentOpticalTable(text: string): boolean {
  const source = normalizePatentOcrText(String(text ?? ''));
  if (!source.trim()) return false;
  return /曲率半径|軸上面間隔|屈折率|アッベ数|\bd\s*\d+\s*[#%*¥]?\s*=|\bN\s*\d+\s*[#%*¥]?\s*=|\bv\s*\d+\s*[#%*¥]?\s*=/i.test(source);
}

function candidateRowsContainPatentAsphereMarkers(rows: LiteratureCandidateRow[]): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some((row) => parsePatentAsphereTerms(row?.line ?? '').hasAny);
}

function candidateRowsContainPatentRadiusMarkers(rows: LiteratureCandidateRow[]): boolean {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.some((row) => textContainsPatentRadiusMarkers(row?.line ?? ''));
}

function countCandidateRowsWithPatentAsphereMarkers(rows: LiteratureCandidateRow[]): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  return rows.reduce((count, row) => count + (parsePatentAsphereTerms(row?.line ?? '').hasAny ? 1 : 0), 0);
}

function getPatentCandidateSurfaceIndex(line: string): number | null {
  const normalized = normalizePatentOcrText(String(line ?? ''));
  const match = normalized.match(/(?:^|[^A-Z0-9])(?:r|d)\s*(\d{1,2})\s*[#%*¥]?\s*=/i)
    || normalized.match(/第\s*(\d{1,2})\s*面/i);
  const value = Number(match?.[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function candidateLineHasRadius(line: string): boolean {
  return /(?:^|[^A-Z0-9])r\s*\d{0,2}\s*[#%*¥]?\s*=\s*(?:\([^)]*\)|INF|INFINITY|∞|[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?)/i.test(normalizePatentOcrText(String(line ?? '')));
}

function candidateLineHasThickness(line: string): boolean {
  return /(?:^|[^A-Z0-9])d\s*\d{0,2}\s*[#%*¥]?\s*=\s*(?:INF|INFINITY|∞|可変|[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?)/i.test(normalizePatentOcrText(String(line ?? '')));
}

function candidateLineIsAsphereLike(line: string): boolean {
  const text = String(line ?? '');
  return /非\s*球面\s*係数/i.test(text) || parsePatentAsphereTerms(text).hasAny;
}

function patentCandidateGeometryScore(line: string): number {
  let score = 0;
  if (candidateLineHasRadius(line)) score += 2;
  if (candidateLineHasThickness(line)) score += 1;
  if (/\bN\s*\d{0,2}\s*[#%*¥]?\s*=/i.test(normalizePatentOcrText(line))) score += 0.2;
  if (/\bv\s*\d{0,2}\s*[#%*¥]?\s*=/i.test(normalizePatentOcrText(line))) score += 0.2;
  return score;
}

function cleanupPatentCandidateRows(rows: LiteratureCandidateRow[]): LiteratureCandidateRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const prepared: Array<{ row: LiteratureCandidateRow; index: number; groupKey: string; surfaceIndex: number | null; score: number; kind: number }> = [];
  const seenLines = new Set<string>();
  const groupOrder = new Map<string, number>();
  const bestGeometryScore = new Map<string, number>();

  rows.forEach((rawRow, index) => {
    const sanitizedLine = sanitizePatentCandidateLine(rawRow?.line ?? '');
    if (!sanitizedLine || isPatentNoiseLine(sanitizedLine)) return;

    const hasGeometry = candidateLineHasRadius(sanitizedLine) || candidateLineHasThickness(sanitizedLine);
    const isAsphereLike = candidateLineIsAsphereLike(sanitizedLine);
    if (!hasGeometry && !isAsphereLike) return;

    const lineKey = sanitizedLine.replace(/\s+/g, ' ').trim().toUpperCase();
    const contextKey = `${rawRow?.embodimentKey ?? 'all'}|${rawRow?.zoomKey ?? 'all'}`;
    const exactKey = `${contextKey}|${lineKey}`;
    if (seenLines.has(exactKey)) return;
    seenLines.add(exactKey);

    if (!groupOrder.has(contextKey)) groupOrder.set(contextKey, groupOrder.size);

    const surfaceIndex = rawRow?.surfaceIndex ?? getPatentCandidateSurfaceIndex(sanitizedLine);
    const score = hasGeometry ? patentCandidateGeometryScore(sanitizedLine) : 0;
    const kind = hasGeometry ? 0 : 1;
    const normalizedNumbers = extractPatentNumbers(sanitizedLine);
    const row = {
      ...rawRow,
      line: sanitizedLine,
      numbers: normalizedNumbers.length > 0 ? normalizedNumbers : rawRow.numbers,
      surfaceIndex,
    };
    prepared.push({ row, index, groupKey: contextKey, surfaceIndex, score, kind });

    if (hasGeometry && surfaceIndex !== null) {
      const geometryKey = `${contextKey}|${surfaceIndex}`;
      bestGeometryScore.set(geometryKey, Math.max(bestGeometryScore.get(geometryKey) ?? 0, score));
    }
  });

  return prepared
    .filter((item) => {
      if (item.kind !== 0 || item.surfaceIndex === null) return true;
      const bestScore = bestGeometryScore.get(`${item.groupKey}|${item.surfaceIndex}`) ?? item.score;
      return !(bestScore >= 3 && item.score < bestScore);
    })
    .sort((left, right) => {
      const groupCompare = (groupOrder.get(left.groupKey) ?? 0) - (groupOrder.get(right.groupKey) ?? 0);
      if (groupCompare !== 0) return groupCompare;
      if (left.kind !== right.kind) return left.kind - right.kind;
      if (left.kind === 0) {
        const leftSurface = left.surfaceIndex ?? 9999;
        const rightSurface = right.surfaceIndex ?? 9999;
        if (leftSurface !== rightSurface) return leftSurface - rightSurface;
      }
      return left.index - right.index;
    })
    .map((item) => item.row);
}

function formatPatentNumericValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  const text = Number(value).toExponential(12).replace(/e\+?/i, 'e');
  const numeric = Number(text);
  return Number.isFinite(numeric)
    ? String(numeric).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
    : String(value);
}

function sanitizePatentCandidateLine(line: string): string {
  const text = String(line ?? '').trim();
  if (!text) return '';

  const withoutContextPrefix = text.replace(/^\[[^\]]+\]\s*/g, '').trim();
    const headerMatch = withoutContextPrefix.match(/(?:【\s*0*\d+\s*】\s*)?\[?\s*第\s*\d+\s*面[^\n]*?非\s*球面\s*(?:係数|データ)\s*\]?/i);
  if (headerMatch) {
    const asphereTerms = parsePatentAsphereTerms(withoutContextPrefix);
    if (asphereTerms.hasAny) {
      const parts: string[] = [normalizePatentAsphereHeaderText(headerMatch[0])];
      if (asphereTerms.conic !== null) parts.push(`epsilon=${formatPatentNumericValue(asphereTerms.conic)}`);
      for (const [indexText, rawValue] of Object.entries(asphereTerms.coefficients).sort((left, right) => Number(left[0]) - Number(right[0]))) {
        const index = Number(indexText);
        if (!Number.isInteger(index) || !Number.isFinite(rawValue)) continue;
        const order = asphereTerms.surfType === 'Aspheric odd' ? (index * 2) + 1 : (index * 2) + 2;
        parts.push(`A${order}=${formatPatentNumericValue(rawValue)}`);
      }
      return parts.join(' ');
    }
    return normalizePatentAsphereHeaderText(headerMatch[0]);
  }

  const asphereTerms = parsePatentAsphereTerms(withoutContextPrefix);
  if (asphereTerms.hasAny) {
    const parts: string[] = [];
    if (asphereTerms.conic !== null) parts.push(`epsilon=${formatPatentNumericValue(asphereTerms.conic)}`);
    for (const [indexText, rawValue] of Object.entries(asphereTerms.coefficients).sort((left, right) => Number(left[0]) - Number(right[0]))) {
      const index = Number(indexText);
      if (!Number.isInteger(index) || !Number.isFinite(rawValue)) continue;
      const order = asphereTerms.surfType === 'Aspheric odd' ? (index * 2) + 1 : (index * 2) + 2;
      parts.push(`A${order}=${formatPatentNumericValue(rawValue)}`);
    }
    if (parts.length > 0) return parts.join(' ');
  }

  const normalized = normalizePatentOcrText(withoutContextPrefix);
  if (isPatentNoiseLine(normalized)) return '';
  if (/[ぁ-んァ-ン一-龯]/.test(normalized) && /\bd\s*\d+\s*[<＜]/i.test(normalized)) return '';
  const radiusPart = normalized.match(/\br\s*\d*\s*[#%*¥]?\s*=\s*(?:\([^)]*\)|INF|INFINITY|∞|[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?)/i)?.[0]?.replace(/[#%*¥](?=\s*=)/g, '').replace(/\s+/g, ' ');
  const thicknessPart = normalized.match(/\bd\s*\d*\s*[#%*¥]?\s*=\s*(?:INF|INFINITY|∞|可変|[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?(?:\s*[~〜]\s*[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?)*)/i)?.[0]?.replace(/[#%*¥](?=\s*=)/g, '').replace(/\s+/g, ' ');
  const refractiveIndexPart = normalized.match(/\bN\s*\d*\s*[#%*¥]?\s*=\s*[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?/i)?.[0]?.replace(/[#%*¥](?=\s*=)/g, '').replace(/\s+/g, ' ');
  const abbePart = normalized.match(/\bv\s*\d*\s*[#%*¥]?\s*=\s*[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?/i)?.[0]?.replace(/[#%*¥](?=\s*=)/g, '').replace(/\s+/g, ' ');
  const stopPart = /絞り|\(stop\)/i.test(normalized) ? 'r= (stop)' : '';
  const parts = [radiusPart || stopPart, thicknessPart, refractiveIndexPart, abbePart].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');

  return withoutContextPrefix;
}

function isPatentOpticalDataLine(line: string): boolean {
  const text = String(line ?? '').trim();
  if (!text) return false;
  if (isPatentNoiseLine(text)) return false;
  if (isPatentAsphereContinuationLine(text)) return true;
  if (/第\s*\d+\s*面|曲率半径|軸上面間隔|屈折率|アッベ数|絞り|\(絞り\)|\(stop\)/i.test(text)) return true;
  return /(?:^|\s)(?:r\s*\d+|d\s*\d+|n\s*\d+|v\s*\d+|r\s*=|d\s*=|n\s*=|v\s*=)/i.test(text);
}

function parseJapanesePatentSurfaceTableLine(line: string): { line: string; numbers: number[]; surfaceIndex: number } | null {
  const source = normalizePatentOcrText(String(line ?? '').trim());
  if (!source) return null;
  if (/^(?:物面|像面|面番号|面データ|単位|数値実施例|非球面)/.test(source)) return null;

  const match = source.match(/^\s*([1-9]\d?)\s*[*＊]?\s*(?:[（(][^）)]*[）)]\s*)?((?:∞|INF|INFINITY)|[+\-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(.*)$/i);
  if (!match) return null;

  const surfaceIndex = Number(match[1]);
  if (!Number.isInteger(surfaceIndex) || surfaceIndex <= 0) return null;

  const radiusRaw = String(match[2] ?? '').trim();
  const rest = String(match[3] ?? '').trim();
  const restValues = Array.from(rest.matchAll(/(?:∞|INF|INFINITY)|可変|[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?/gi)).map((item) => String(item[0] ?? '').trim());
  if (restValues.length === 0) return null;

  const parts = [`r${surfaceIndex}=${isInfLikePatentImport(radiusRaw) ? 'INF' : radiusRaw}`];
  const thicknessRaw = restValues[0];
  if (thicknessRaw) parts.push(`d${surfaceIndex}=${isInfLikePatentImport(thicknessRaw) ? 'INF' : thicknessRaw}`);

  const numericTail = restValues.slice(1)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const refractiveIndex = numericTail.find((value) => value > 1 && value < 3.5) ?? null;
  const abbe = numericTail.find((value) => value > 10 && value < 100) ?? null;
  if (refractiveIndex !== null) parts.push(`N${surfaceIndex}=${String(refractiveIndex)}`);
  if (abbe !== null) parts.push(`v${surfaceIndex}=${String(abbe)}`);

  const normalizedLine = parts.join(' ');
  return {
    line: normalizedLine,
    numbers: extractPatentNumbers(normalizedLine),
    surfaceIndex,
  };
}

function isPatentAsphereContinuationLine(line: string): boolean {
  return /^\s*(?:(?:surface|surf\.?|s)\s*\d{1,2}\s*(?:asph(?:eric)?|非球面|coefficients?|coef)|(?:\d{1,2})(?:st|nd|rd|th)\s*(?:surface|surf\.?)\s*(?:asph(?:eric)?|coefficients?|coef)|asph(?:eric)?|conic(?:\s*constant)?|cc(?:\s*[:=])?|k(?:\s*[:=])?|epsilon(?:\s*[:=])?|[εϵ](?:\s*[:=])?|[&gq](?:\s*[:=])?|a\s*(?:3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22|[dD]|[Il|]\s*[0-9])(?:\s*[:=]|\s*=\-|\s*--)?|coef\s*(?:10|[1-9])(?:\s*[:=])?|非球面|非球面データ|非球面係数|円錐定数|コーニック定数|コニック定数|円すい定数|2次曲面パラメータ|二次曲面パラメータ|係数\s*[A-D]?\s*(?:3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22)\b)/i.test(normalizePatentAsphereLine(String(line ?? '').trim()));
}

function applyPatentAsphereTerms(row: Record<string, any>, terms: PatentAsphereTerms): void {
  if (!row || !terms.hasAny) return;
  const surfType = String(row.surfType ?? '').trim();
  if (!surfType || surfType === 'Spherical') {
    row.surfType = terms.surfType || 'Aspheric even';
  }
  if (terms.conic !== null) {
    row.conic = String(terms.conic);
  }
  for (const [indexText, value] of Object.entries(terms.coefficients)) {
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 1 || index > 10) continue;
    row[`coef${index}`] = String(value);
  }
}

function buildFallbackBlocksFromRows(rows: Array<Record<string, any>>, preserveSurfaces = false): any[] {
  const safeRows = Array.isArray(rows) ? rows : [];
  const blocks: any[] = [];

  const inferImageSemidia = (): number | null => {
    for (let index = safeRows.length - 1; index >= 0; index -= 1) {
      const row = safeRows[index] || {};
      const raw = row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'];
      const numeric = Number(raw);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
    return null;
  };

  const firstRow = safeRows[0] || {};
  const objectDistanceMode = isInfLikePatentImport(firstRow?.thickness) ? 'INF' : 'Finite';
  const objectDistance = Number(firstRow?.thickness);
  const objectRenderDistance = Number(firstRow?.objectRenderDistance);
  const objectParameters: Record<string, any> = objectDistanceMode === 'INF'
    ? { objectDistanceMode: 'INF' }
    : { objectDistanceMode: 'Finite' };
  if (objectDistanceMode === 'INF') {
    if (Number.isFinite(objectRenderDistance) && objectRenderDistance > 0) objectParameters.objectDistance = objectRenderDistance;
  } else if (Number.isFinite(objectDistance) && objectDistance > 0) {
    objectParameters.objectDistance = objectDistance;
  }
  blocks.push({
    blockId: 'ObjectSurface-1',
    blockType: 'ObjectSurface',
    role: null,
    constraints: {},
    parameters: objectParameters,
    variables: {},
    metadata: { source: 'patent-import-fallback' },
  });

  let stopCount = 0;
  let lensCount = 0;
  let doubletCount = 0;
  let tripletCount = 0;
  let gapCount = 0;
  const end = Math.max(1, safeRows.length - 1);

  const rowObjectType = (row: Record<string, any>): string => String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
  const isStopRow = (row: Record<string, any>): boolean => {
    const objectType = rowObjectType(row);
    return objectType === 'stop' || objectType === 'sto';
  };
  const isFallbackGapRow = (row: Record<string, any>): boolean => {
    if (!row || typeof row !== 'object') return false;
    if (row._patentImportKind === 'surface') return false;
    return isPatentGapRow(row);
  };
  const getSemidia = (row: Record<string, any>): any => row?.semidia ?? row?.semiDiameter ?? row?.semiDia ?? row?.['semi diameter'] ?? row?.['Semi Diameter'] ?? '';
  const normalizeBlockRadius = (value: any): any => isInfLikePatentImport(value) ? 'INF' : (String(value ?? '').trim() === '' ? 'INF' : value);
  const normalizeBlockThickness = (value: any): string | number => {
    if (isInfLikePatentImport(value)) return 'INF';
    if (isVariableLikePatentImport(value)) return 0;
    const text = String(value ?? '').trim();
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : (text || 0);
  };
  const getMediumMaterial = (row: Record<string, any>): string => {
    const material = String(row?.material ?? '').trim();
    if (material && material.toUpperCase() !== 'AIR') return material;
    const rindex = String(row?.rindex ?? '').trim();
    return rindex || '';
  };
  const materialKey = (value: string): string => String(value ?? '').replace(/\s+/g, '').toUpperCase();
  const hasPostGap = (row: Record<string, any>): boolean => {
    const thickness = normalizeBlockThickness(row?.thickness);
    return thickness === 'INF'
      || isVariableLikePatentImport(row?.thickness)
      || (typeof thickness === 'number' && Number.isFinite(thickness) && Math.abs(thickness) > 1e-12);
  };
  const isStandaloneGapLikeRow = (row: Record<string, any>): boolean => {
    if (!row || typeof row !== 'object') return false;
    if (row._patentImportKind === 'gap') return true;
    const material = String(row?.material ?? '').trim().toUpperCase();
    const rindex = String(row?.rindex ?? '').trim();
    const abbe = String(row?.abbe ?? '').trim();
    if (material !== 'AIR') return false;
    if (rindex || abbe) return false;
    return hasPostGap(row);
  };
  const appendGapAfterSurface = (row: Record<string, any>, rowIndex: number, from: string, groupMaterials: string[] = []) => {
    if (!hasPostGap(row)) return;
    gapCount += 1;
    const rawMaterial = String(row?.material ?? '').trim();
    const rawMaterialKey = materialKey(rawMaterial);
    const groupMaterialKeys = new Set(groupMaterials.map((material) => materialKey(material)).filter(Boolean));
    const gapMaterial = rawMaterial && rawMaterialKey !== 'AIR' && !groupMaterialKeys.has(rawMaterialKey) ? rawMaterial : 'AIR';
    blocks.push({
      blockId: `Gap-${gapCount}`,
      blockType: 'Gap',
      role: null,
      constraints: {},
      parameters: { thickness: normalizeBlockThickness(row?.thickness), material: gapMaterial },
      variables: {},
      metadata: { source: 'patent-import-fallback', from, rowIndex },
    });
  };
  const copySurfaceShapeParams = (row: Record<string, any>, prefix: string): Record<string, any> => {
    const params: Record<string, any> = {};
    const surfType = String(row?.surfType ?? '').trim() || 'Spherical';
    params[`${prefix}SurfType`] = surfType;
    const conicText = String(row?.conic ?? '').trim();
    if (conicText) {
      const conicNumeric = Number(conicText);
      params[`${prefix}Conic`] = Number.isFinite(conicNumeric) ? conicNumeric : conicText;
    }
    for (let coefIndex = 1; coefIndex <= 10; coefIndex += 1) {
      const coefText = String(row?.[`coef${coefIndex}`] ?? '').trim();
      if (!coefText) continue;
      const coefNumeric = Number(coefText);
      params[`${prefix}Coef${coefIndex}`] = Number.isFinite(coefNumeric) ? coefNumeric : coefText;
    }
    if (surfType === 'Toric') {
      const radiusXText = String(row?.radiusX ?? '').trim();
      if (radiusXText) params[`${prefix}RadiusX`] = normalizeBlockRadius(row.radiusX);
      const axisNumeric = Number(row?.axis);
      if (Number.isFinite(axisNumeric)) params[`${prefix}Axis`] = axisNumeric;
    }
    return params;
  };
  const makeSingleSurfaceParams = (row: Record<string, any>): Record<string, any> => {
    const surfType = String(row?.surfType ?? '').trim() || 'Spherical';
    const params: Record<string, any> = {
      radius: normalizeBlockRadius(row?.radius),
      thickness: normalizeBlockThickness(row?.thickness),
      material: String(row?.material ?? '').trim(),
      rindex: String(row?.rindex ?? '').trim(),
      abbe: String(row?.abbe ?? '').trim(),
      surfType,
      semidia: getSemidia(row),
    };
    const conicText = String(row?.conic ?? '').trim();
    if (conicText) {
      const conicNumeric = Number(conicText);
      params.conic = Number.isFinite(conicNumeric) ? conicNumeric : conicText;
    }
    if (surfType === 'Toric') {
      params.radiusX = normalizeBlockRadius(row?.radiusX);
      params.radiusY = normalizeBlockRadius(row?.radiusY);
      const axisNumeric = Number(row?.axis);
      params.axis = Number.isFinite(axisNumeric) ? axisNumeric : 0;
    }
    for (let coefIndex = 1; coefIndex <= 10; coefIndex += 1) {
      const coefText = String(row?.[`coef${coefIndex}`] ?? '').trim();
      if (!coefText) continue;
      const coefNumeric = Number(coefText);
      params[`coef${coefIndex}`] = Number.isFinite(coefNumeric) ? coefNumeric : coefText;
    }
    return params;
  };
  const makeLensParamsFromSingleSurface = (row: Record<string, any>): Record<string, any> => {
    const material = String(row?.material ?? '').trim();
    const rindex = String(row?.rindex ?? '').trim();
    const abbe = String(row?.abbe ?? '').trim();
    const params: Record<string, any> = {
      frontRadius: normalizeBlockRadius(row?.radius),
      backRadius: 'INF',
      centerThickness: normalizeBlockThickness(row?.thickness),
      material: material || (rindex ? rindex : 'N-BK7'),
      ...copySurfaceShapeParams(row, 'front'),
      backSurfType: 'Spherical',
      backConic: 0,
    };
    if (rindex) params.rindex = rindex;
    if (abbe) params.abbe = abbe;
    return params;
  };
  const scanElementGroup = (startIndex: number): { rows: Array<{ row: Record<string, any>; rowIndex: number }>; elementCount: number; materials: string[] } | null => {
    const groupRows: Array<{ row: Record<string, any>; rowIndex: number }> = [];
    const materials: string[] = [];
    for (let scanIndex = startIndex; scanIndex < end; scanIndex += 1) {
      const candidateRow = safeRows[scanIndex] || {};
      if (isStopRow(candidateRow) || isFallbackGapRow(candidateRow) || isStandaloneGapLikeRow(candidateRow)) break;
      const mediumMaterial = getMediumMaterial(candidateRow);
      groupRows.push({ row: candidateRow, rowIndex: scanIndex });
      if (mediumMaterial) {
        materials.push(mediumMaterial);
        if (materials.length > 3) return null;
        continue;
      }
      if (materials.length > 0 && groupRows.length === materials.length + 1) {
        return { rows: groupRows, elementCount: materials.length, materials };
      }
      return null;
    }
    return null;
  };

  for (let index = 1; index < end; index += 1) {
    const row = safeRows[index] || {};
    if (isStopRow(row)) {
      stopCount += 1;
      const stopSemidiaRaw = getSemidia(row);
      const stopSemidia = Number(stopSemidiaRaw);
      blocks.push({
        blockId: `Stop-${stopCount}`,
        blockType: 'Stop',
        role: null,
        constraints: {},
        parameters: Number.isFinite(stopSemidia) && stopSemidia > 0 ? { semiDiameter: stopSemidia } : {},
        variables: {},
        metadata: { source: 'patent-import-fallback' },
      });

      const thicknessRaw = row?.thickness;
      const thicknessNumeric = Number(thicknessRaw);
      const hasGap = isInfLikePatentImport(thicknessRaw)
        || isVariableLikePatentImport(thicknessRaw)
        || (Number.isFinite(thicknessNumeric) && Math.abs(thicknessNumeric) > 1e-12);
      if (hasGap) {
        gapCount += 1;
        blocks.push({
          blockId: `Gap-${gapCount}`,
          blockType: 'Gap',
          role: null,
          constraints: {},
          parameters: { thickness: isInfLikePatentImport(thicknessRaw) ? 'INF' : thicknessNumeric, material: 'AIR' },
          variables: {},
          metadata: { source: 'patent-import-fallback', from: 'stop-thickness' },
        });
      }
      continue;
    }

    if (isFallbackGapRow(row)) {
      const thicknessRaw = row?.thickness;
      const thicknessNumeric = Number(thicknessRaw);
      const hasGap = isInfLikePatentImport(thicknessRaw)
        || isVariableLikePatentImport(thicknessRaw)
        || (Number.isFinite(thicknessNumeric) && Math.abs(thicknessNumeric) > 1e-12);
      if (hasGap) {
        gapCount += 1;
        blocks.push({
          blockId: `Gap-${gapCount}`,
          blockType: 'Gap',
          role: null,
          constraints: {},
          parameters: {
            thickness: isInfLikePatentImport(thicknessRaw) ? 'INF' : thicknessNumeric,
            material: 'AIR',
          },
          variables: {},
          metadata: { source: 'patent-import-fallback', from: 'gap-row', rowIndex: index },
        });
      }
      continue;
    }

    if (preserveSurfaces) {
      if (isStandaloneGapLikeRow(row)) {
        gapCount += 1;
        blocks.push({
          blockId: `Gap-${gapCount}`,
          blockType: 'Gap',
          role: null,
          constraints: {},
          parameters: { thickness: normalizeBlockThickness(row?.thickness), material: 'AIR' },
          variables: {},
          metadata: { source: 'patent-import-fallback', rowIndex: index, preserveSurface: true, gapLikeFallback: true },
        });
        continue;
      }
      lensCount += 1;
      blocks.push({
        blockId: `Lens-${lensCount}`,
        blockType: 'Lens',
        role: null,
        constraints: {},
        parameters: makeLensParamsFromSingleSurface(row),
        aperture: { front: getSemidia(row), back: getSemidia(row) },
        variables: {},
        metadata: { source: 'patent-import-fallback', rowIndex: index, preserveSurface: true, singleSurfaceFallback: true },
      });
      continue;
    }

    const elementGroup = scanElementGroup(index);
    if (elementGroup && elementGroup.elementCount === 1 && elementGroup.rows.length >= 2) {
      lensCount += 1;
      const frontSurface = elementGroup.rows[0];
      const backSurface = elementGroup.rows[1];
      const material = elementGroup.materials[0] || 'N-BK7';
      const params: Record<string, any> = {
        frontRadius: normalizeBlockRadius(frontSurface.row.radius),
        backRadius: normalizeBlockRadius(backSurface.row.radius),
        centerThickness: normalizeBlockThickness(frontSurface.row.thickness),
        material,
        ...copySurfaceShapeParams(frontSurface.row, 'front'),
        ...copySurfaceShapeParams(backSurface.row, 'back'),
      };
      const rindex = String(frontSurface.row?.rindex ?? '').trim();
      const abbe = String(frontSurface.row?.abbe ?? '').trim();
      if (rindex) params.rindex = rindex;
      if (abbe) params.abbe = abbe;
      blocks.push({
        blockId: `Lens-${lensCount}`,
        blockType: 'Lens',
        role: null,
        constraints: {},
        parameters: params,
        aperture: { front: getSemidia(frontSurface.row), back: getSemidia(backSurface.row) },
        variables: {},
        metadata: { source: 'patent-import-fallback', rowRange: [frontSurface.rowIndex, backSurface.rowIndex] },
      });
      appendGapAfterSurface(backSurface.row, backSurface.rowIndex, 'lens-exit-thickness', elementGroup.materials);
      index += elementGroup.rows.length - 1;
      continue;
    }

    if (elementGroup && elementGroup.elementCount === 2 && elementGroup.rows.length >= 3) {
      doubletCount += 1;
      const firstSurface = elementGroup.rows[0];
      const secondSurface = elementGroup.rows[1];
      const thirdSurface = elementGroup.rows[2];
      const params: Record<string, any> = {
        radius1: normalizeBlockRadius(firstSurface.row.radius),
        radius2: normalizeBlockRadius(secondSurface.row.radius),
        radius3: normalizeBlockRadius(thirdSurface.row.radius),
        thickness1: normalizeBlockThickness(firstSurface.row.thickness),
        thickness2: normalizeBlockThickness(secondSurface.row.thickness),
        material1: elementGroup.materials[0] || 'N-BK7',
        material2: elementGroup.materials[1] || 'N-SF5',
        ...copySurfaceShapeParams(firstSurface.row, 'surf1'),
        ...copySurfaceShapeParams(secondSurface.row, 'surf2'),
        ...copySurfaceShapeParams(thirdSurface.row, 'surf3'),
      };
      const abbe1 = String(firstSurface.row?.abbe ?? '').trim();
      const abbe2 = String(secondSurface.row?.abbe ?? '').trim();
      if (abbe1) params.abbe1 = abbe1;
      if (abbe2) params.abbe2 = abbe2;
      blocks.push({
        blockId: `Doublet-${doubletCount}`,
        blockType: 'Doublet',
        role: null,
        constraints: {},
        parameters: params,
        aperture: { s1: getSemidia(firstSurface.row), s2: getSemidia(secondSurface.row), s3: getSemidia(thirdSurface.row) },
        variables: {},
        metadata: { source: 'patent-import-fallback', rowRange: [firstSurface.rowIndex, thirdSurface.rowIndex] },
      });
      appendGapAfterSurface(thirdSurface.row, thirdSurface.rowIndex, 'doublet-exit-thickness', elementGroup.materials);
      index += elementGroup.rows.length - 1;
      continue;
    }

    if (elementGroup && elementGroup.elementCount === 3 && elementGroup.rows.length >= 4) {
      tripletCount += 1;
      const firstSurface = elementGroup.rows[0];
      const secondSurface = elementGroup.rows[1];
      const thirdSurface = elementGroup.rows[2];
      const fourthSurface = elementGroup.rows[3];
      const params: Record<string, any> = {
        radius1: normalizeBlockRadius(firstSurface.row.radius),
        radius2: normalizeBlockRadius(secondSurface.row.radius),
        radius3: normalizeBlockRadius(thirdSurface.row.radius),
        radius4: normalizeBlockRadius(fourthSurface.row.radius),
        thickness1: normalizeBlockThickness(firstSurface.row.thickness),
        thickness2: normalizeBlockThickness(secondSurface.row.thickness),
        thickness3: normalizeBlockThickness(thirdSurface.row.thickness),
        material1: elementGroup.materials[0] || 'N-BK7',
        material2: elementGroup.materials[1] || 'N-SF5',
        material3: elementGroup.materials[2] || 'N-BK7',
        ...copySurfaceShapeParams(firstSurface.row, 'surf1'),
        ...copySurfaceShapeParams(secondSurface.row, 'surf2'),
        ...copySurfaceShapeParams(thirdSurface.row, 'surf3'),
        ...copySurfaceShapeParams(fourthSurface.row, 'surf4'),
      };
      const abbe1 = String(firstSurface.row?.abbe ?? '').trim();
      const abbe2 = String(secondSurface.row?.abbe ?? '').trim();
      const rindex3 = String(thirdSurface.row?.rindex ?? '').trim();
      const abbe3 = String(thirdSurface.row?.abbe ?? '').trim();
      if (abbe1) params.abbe1 = abbe1;
      if (abbe2) params.abbe2 = abbe2;
      if (rindex3) params.rindex3 = rindex3;
      if (abbe3) params.abbe3 = abbe3;
      blocks.push({
        blockId: `Triplet-${tripletCount}`,
        blockType: 'Triplet',
        role: null,
        constraints: {},
        parameters: params,
        aperture: { s1: getSemidia(firstSurface.row), s2: getSemidia(secondSurface.row), s3: getSemidia(thirdSurface.row), s4: getSemidia(fourthSurface.row) },
        variables: {},
        metadata: { source: 'patent-import-fallback', rowRange: [firstSurface.rowIndex, fourthSurface.rowIndex] },
      });
      appendGapAfterSurface(fourthSurface.row, fourthSurface.rowIndex, 'triplet-exit-thickness', elementGroup.materials);
      index += elementGroup.rows.length - 1;
      continue;
    }

    if (isStandaloneGapLikeRow(row)) {
      gapCount += 1;
      blocks.push({
        blockId: `Gap-${gapCount}`,
        blockType: 'Gap',
        role: null,
        constraints: {},
        parameters: { thickness: normalizeBlockThickness(row?.thickness), material: 'AIR' },
        variables: {},
        metadata: { source: 'patent-import-fallback', rowIndex: index, gapLikeFallback: true },
      });
      continue;
    }

    lensCount += 1;
    blocks.push({
      blockId: `Lens-${lensCount}`,
      blockType: 'Lens',
      role: null,
      constraints: {},
      parameters: makeLensParamsFromSingleSurface(row),
      aperture: { front: getSemidia(row), back: getSemidia(row) },
      variables: {},
      metadata: { source: 'patent-import-fallback', rowIndex: index, singleSurfaceFallback: true },
    });
  }

  const imageSemidia = inferImageSemidia();
  blocks.push({
    blockId: 'ImageSurface-1',
    blockType: 'ImageSurface',
    role: null,
    constraints: {},
    parameters: Number.isFinite(imageSemidia as any) && (imageSemidia as number) > 0
      ? { semidia: imageSemidia, semidiaMode: 'Auto', optimizeSemiDia: 'A' }
      : { semidiaMode: 'Auto', optimizeSemiDia: 'A' },
    variables: {},
    metadata: { source: 'patent-import-fallback' },
  });

  return blocks;
}

function normalizeObjectDistanceInBlocks(blocks: any[]): any[] {
  if (!Array.isArray(blocks)) return [];

  let hasObjectSurface = false;
  for (const block of blocks) {
    if (!block || block.blockType !== 'ObjectSurface') continue;
    hasObjectSurface = true;
    const params = (block.parameters && typeof block.parameters === 'object')
      ? block.parameters
      : (block.parameters = {});

    const modeRaw = String(params.objectDistanceMode ?? '').trim();
    if (isInfLikePatentImport(modeRaw)) {
      params.objectDistanceMode = 'INF';
      const distanceInf = Number(params.objectDistance);
      if (Number.isFinite(distanceInf) && distanceInf > 0) params.objectDistance = distanceInf;
      else delete params.objectDistance;
      continue;
    }

    params.objectDistanceMode = 'Finite';
    const distance = Number(params.objectDistance);
    if (Number.isFinite(distance) && distance > 0) params.objectDistance = distance;
    else delete params.objectDistance;
  }

  if (!hasObjectSurface) {
    blocks.unshift({
      blockId: 'ObjectSurface-1',
      blockType: 'ObjectSurface',
      role: null,
      constraints: {},
      parameters: { objectDistanceMode: 'Finite' },
      variables: {},
      metadata: { source: 'patent-import-fallback', inserted: true },
    });
  }

  return blocks;
}

function attachPatentImportMetadataToBlocks(blocks: any[], summaryText: string, appliedAt: string): any[] {
  if (!Array.isArray(blocks)) return [];
  const summary = String(summaryText ?? '').trim();
  return blocks.map((block) => {
    if (!block || typeof block !== 'object') return block;
    return {
      ...block,
      metadata: {
        ...(block.metadata && typeof block.metadata === 'object' ? block.metadata : {}),
        importSource: 'patent-import',
        importAppliedAt: appliedAt,
        literatureImportSummary: summary,
      },
    };
  });
}

async function persistLiteratureSummaryToActiveConfig(summaryText: string): Promise<void> {
  const summary = String(summaryText ?? '').trim();
  if (!summary) return;

  const [{ loadSystemConfigurations, saveSystemConfigurations }, { requestRefreshBlockInspector }] = await Promise.all([
    import('../../../data/table-configuration.ts'),
    import('../../../core/window-facade.ts'),
  ]);

  const systemConfig = loadSystemConfigurations();
  const activeConfig = Array.isArray(systemConfig?.configurations)
    ? systemConfig.configurations.find((config: any) => String(config?.id) === String(systemConfig?.activeConfigId)) || systemConfig.configurations[0]
    : null;
  if (!activeConfig) return;

  const nowIso = new Date().toISOString();
  activeConfig.systemData = {
    ...(activeConfig.systemData || {}),
    literatureImportSummary: summary,
  };
  activeConfig.metadata = {
    ...(activeConfig.metadata || {}),
    modified: nowIso,
    literatureImportSummary: summary,
  };
  if (Array.isArray(activeConfig.blocks)) {
    activeConfig.blocks = attachPatentImportMetadataToBlocks(activeConfig.blocks, summary, nowIso);
  }
  saveSystemConfigurations(systemConfig);

  try {
    requestRefreshBlockInspector(window);
  } catch (_) {}
}

function makeOption(key: string, label: string, zoomIndex: number | null = null): LiteratureOption {
  return { key, label, zoomIndex };
}

function normalizeEmbodiment(rawValue: string): LiteratureOption {
  const value = String(rawValue ?? '').trim();
  if (!value) return makeOption('all', 'All');
  const match = value.match(/(embodiment|example|numerical example|実施例)\s*([A-Za-z0-9一二三四五六七八九十\-]+)/i);
  if (match) {
    const suffix = String(match[2] ?? '').trim();
    return makeOption(`embodiment-${suffix.toLowerCase()}`, `Embodiment ${suffix}`);
  }
  return makeOption(value.toLowerCase().replace(/\s+/g, '-'), value);
}

function normalizeZoomPosition(rawValue: string): LiteratureOption {
  const value = String(rawValue ?? '').trim();
  const lower = value.toLowerCase();
  if (!value) return makeOption('all', 'All', null);
  if (/(wide|wide end|short focal|広角|ワイド)/i.test(value)) return makeOption('wide', 'Wide', 0);
  if (/(middle|mid|中間)/i.test(value)) return makeOption('mid', 'Mid', 1);
  if (/(tele|tele end|long focal|望遠|テレ)/i.test(value)) return makeOption('tele', 'Tele', 2);
  const numberMatch = lower.match(/(?:zoom|position|state|point)\s*([1-9]\d*)/i);
  if (numberMatch) {
    const zoomIndex = Math.max(0, Number(numberMatch[1]) - 1);
    return makeOption(`position-${numberMatch[1]}`, `Position ${numberMatch[1]}`, zoomIndex);
  }
  return makeOption(lower.replace(/\s+/g, '-'), value, null);
}

function buildInferredZoomOptions(values: number[]): LiteratureOption[] {
  const count = Array.isArray(values) ? values.length : 0;
  if (count >= 3) return [makeOption('wide', 'Wide', 0), makeOption('mid', 'Mid', 1), makeOption('tele', 'Tele', 2)];
  if (count === 2) return [makeOption('wide', 'Wide', 0), makeOption('tele', 'Tele', 1)];
  if (count === 1) return [makeOption('position-1', 'Position 1', 0)];
  return [];
}

function parseContextualCandidateRows(text: string): { rows: LiteratureCandidateRow[]; embodiments: LiteratureOption[]; zoomPositions: LiteratureOption[] } {
  const embodiments = new Map<string, LiteratureOption>();
  const zoomPositions = new Map<string, LiteratureOption>();
  const rows: LiteratureCandidateRow[] = [];

  const defaultEmbodiment = makeOption('all', 'All');
  const defaultZoom = makeOption('all', 'All');
  embodiments.set(defaultEmbodiment.key, defaultEmbodiment);
  zoomPositions.set(defaultZoom.key, defaultZoom);

  let currentEmbodiment = defaultEmbodiment;
  let currentZoom = defaultZoom;
  let currentAsphereSurfaceIndex: number | null = null;
  let inAsphereDataSection = false;

  const embodimentPattern = /(embodiment|example|numerical example|実施例)\s*[#:]?\s*([A-Za-z0-9一二三四五六七八九十\-]+)/i;
  const zoomPattern = /(wide end|wide|tele end|tele|middle|mid|short focal length|long focal length|広角端|望遠端|中間|ワイド|テレ|zoom\s*[1-9]\d*|position\s*[1-9]\d*|state\s*[1-9]\d*)/i;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/非\s*球面\s*(?:データ|係数)/i.test(line)) {
      inAsphereDataSection = true;
    }

    const embodimentMatch = line.match(embodimentPattern);
    if (embodimentMatch) {
      currentEmbodiment = normalizeEmbodiment(embodimentMatch[0]);
      embodiments.set(currentEmbodiment.key, currentEmbodiment);
    }

    const zoomMatch = line.match(zoomPattern);
    if (zoomMatch) {
      currentZoom = normalizeZoomPosition(zoomMatch[0]);
      zoomPositions.set(currentZoom.key, currentZoom);
    }

    const surfaceIndexHint = extractPatentSurfaceIndexHint(line);
    if ((inAsphereDataSection || /非\s*球面|円錐定数|コーニック定数|コニック定数|2次曲面パラメータ|二次曲面パラメータ/i.test(line)) && surfaceIndexHint !== null) {
      currentAsphereSurfaceIndex = surfaceIndexHint;
    }

    const japaneseSurfaceRow = parseJapanesePatentSurfaceTableLine(line);
    if (japaneseSurfaceRow) {
      rows.push({
        line: japaneseSurfaceRow.line,
        numbers: japaneseSurfaceRow.numbers,
        embodimentKey: currentEmbodiment.key,
        embodimentLabel: currentEmbodiment.label,
        zoomKey: currentZoom.key,
        zoomLabel: currentZoom.label,
        surfaceIndex: japaneseSurfaceRow.surfaceIndex,
      });
      continue;
    }

    const numbers = extractPatentNumbers(line);
    const asphereTerms = parsePatentAsphereTerms(line);
    const isAsphereContinuation = asphereTerms.hasAny && isPatentAsphereContinuationLine(line);
    const isOpticalDataLine = isPatentOpticalDataLine(line);
    if ((!isAsphereContinuation && numbers.length < 3) || numbers.length > 16) continue;
    if (/^\s*(f\/?#|fno|focal|half\s*angle|field\s*angle|image\s*height|total\s*length|ttl|oal|tl)\b/i.test(line)) continue;
    if (!isOpticalDataLine && surfaceIndexHint === null) continue;

    rows.push({
      line: sanitizePatentCandidateLine(line),
      numbers,
      embodimentKey: currentEmbodiment.key,
      embodimentLabel: currentEmbodiment.label,
      zoomKey: currentZoom.key,
      zoomLabel: currentZoom.label,
      surfaceIndex: surfaceIndexHint ?? (isAsphereContinuation ? currentAsphereSurfaceIndex : null),
    });
  }

  return {
    rows: cleanupPatentCandidateRows(mergeSequentialPatentCandidateRows(text, rows)),
    embodiments: Array.from(embodiments.values()),
    zoomPositions: Array.from(zoomPositions.values()),
  };
}

function mergeSequentialPatentCandidateRows(text: string, existingRows: LiteratureCandidateRow[]): LiteratureCandidateRow[] {
  const mergedRows = Array.isArray(existingRows) ? [...existingRows] : [];
  const seenLines = new Set(mergedRows.map((row) => String(row?.line ?? '').trim()).filter(Boolean));
  const lines = String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const defaultEmbodiment = makeOption('all', 'All');
  const defaultZoom = makeOption('all', 'All');
  let currentEmbodiment = defaultEmbodiment;
  let currentZoom = defaultZoom;

  const embodimentPattern = /(embodiment|example|numerical example|実施例)\s*[#:]?\s*([A-Za-z0-9一二三四五六七八九十\-]+)/i;
  const zoomPattern = /(wide end|wide|tele end|tele|middle|mid|short focal length|long focal length|広角端|望遠端|中間|ワイド|テレ|zoom\s*[1-9]\d*|position\s*[1-9]\d*|state\s*[1-9]\d*)/i;

  type PendingSurface = {
    surfaceIndex: number;
    radiusPart: string;
    thicknessPart: string;
    embodimentKey: string;
    embodimentLabel: string;
    zoomKey: string;
    zoomLabel: string;
    order: number;
  };

  const pending = new Map<number, PendingSurface>();
  let orderCounter = 0;
  let lastRadiusSurfaceIndex: number | null = null;
  let lastThicknessSurfaceIndex: number | null = null;

  const flushPending = (surfaceIndex: number) => {
    const item = pending.get(surfaceIndex);
    if (!item || !item.radiusPart || !item.thicknessPart) return;
    const line = `${item.radiusPart} ${item.thicknessPart}`.trim();
    const sanitizedLine = sanitizePatentCandidateLine(line);
    const sanitizedThicknessLine = sanitizePatentCandidateLine(item.thicknessPart);
    if (sanitizedThicknessLine) {
      for (let rowIndex = mergedRows.length - 1; rowIndex >= 0; rowIndex -= 1) {
        if (String(mergedRows[rowIndex]?.line ?? '').trim() !== sanitizedThicknessLine) continue;
        mergedRows.splice(rowIndex, 1);
        seenLines.delete(sanitizedThicknessLine);
      }
    }
    if (seenLines.has(sanitizedLine)) {
      pending.delete(surfaceIndex);
      return;
    }
    const numbers = extractPatentNumbers(sanitizedLine);
    if (numbers.length === 0) {
      pending.delete(surfaceIndex);
      return;
    }
    mergedRows.push({
      line: sanitizedLine,
      numbers,
      embodimentKey: item.embodimentKey,
      embodimentLabel: item.embodimentLabel,
      zoomKey: item.zoomKey,
      zoomLabel: item.zoomLabel,
      surfaceIndex: surfaceIndex,
    });
    seenLines.add(sanitizedLine);
    pending.delete(surfaceIndex);
  };

  for (const line of lines) {
    const normalizedLine = normalizePatentOcrText(line);

    const embodimentMatch = line.match(embodimentPattern);
    if (embodimentMatch) {
      currentEmbodiment = normalizeEmbodiment(embodimentMatch[0]);
    }

    const zoomMatch = line.match(zoomPattern);
    if (zoomMatch) {
      currentZoom = normalizeZoomPosition(zoomMatch[0]);
    }

    const contextualRadiusMatch = line.match(/^\s*([1-9]\d?)\s*[#%*¥]?\s*(?:=|\s+)\s*([+\-]?(?:\d+(?:[.,]\d+)?|\.\d+)(?:e[+\-]?\d+)?)/i);
    if (contextualRadiusMatch) {
      const surfaceIndex = Number(contextualRadiusMatch[1]);
      const value = String(contextualRadiusMatch[2] ?? '').replace(',', '.');
      const followsPreviousThickness = Number.isInteger(surfaceIndex) && lastThicknessSurfaceIndex === surfaceIndex - 1;
      const alreadyHasRadius = Number.isInteger(surfaceIndex) && !!pending.get(surfaceIndex)?.radiusPart;
      if (followsPreviousThickness && !alreadyHasRadius) {
        const next = pending.get(surfaceIndex) || {
          surfaceIndex,
          radiusPart: '',
          thicknessPart: '',
          embodimentKey: currentEmbodiment.key,
          embodimentLabel: currentEmbodiment.label,
          zoomKey: currentZoom.key,
          zoomLabel: currentZoom.label,
          order: orderCounter += 1,
        };
        next.radiusPart = `r${surfaceIndex}= ${value}`;
        pending.set(surfaceIndex, next);
        lastRadiusSurfaceIndex = surfaceIndex;
        flushPending(surfaceIndex);
        continue;
      }
    }

    const unlabeledThicknessMatch = normalizedLine.match(/^\s*=\s*(.+)$/i);
    if (unlabeledThicknessMatch && lastRadiusSurfaceIndex !== null) {
      const surfaceIndex = lastRadiusSurfaceIndex;
      const next = pending.get(surfaceIndex);
      if (next?.radiusPart && !next.thicknessPart) {
        next.thicknessPart = `d${surfaceIndex}= ${String(unlabeledThicknessMatch[1] ?? '').trim()}`;
        pending.set(surfaceIndex, next);
        lastThicknessSurfaceIndex = surfaceIndex;
        flushPending(surfaceIndex);
        continue;
      }
    }

    const radiusMatch = normalizedLine.match(/\br\s*(\d+)[#%*¥]?\s*=\s*(\([^)]*絞[^)]*\)|\([^)]*stop[^)]*\)|INF|INFINITY|∞|[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?)/i);
    if (radiusMatch) {
      const surfaceIndex = Number(radiusMatch[1]);
      if (Number.isInteger(surfaceIndex)) {
        const next = pending.get(surfaceIndex) || {
          surfaceIndex,
          radiusPart: '',
          thicknessPart: '',
          embodimentKey: currentEmbodiment.key,
          embodimentLabel: currentEmbodiment.label,
          zoomKey: currentZoom.key,
          zoomLabel: currentZoom.label,
          order: orderCounter += 1,
        };
        next.radiusPart = /絞|stop/i.test(radiusMatch[2]) ? `r${surfaceIndex}= (stop)` : `r${surfaceIndex}= ${radiusMatch[2]}`;
        pending.set(surfaceIndex, next);
        lastRadiusSurfaceIndex = surfaceIndex;
        flushPending(surfaceIndex);
        continue;
      }
    }

    const thicknessMatch = normalizedLine.match(/\bd\s*(\d+)\s*=\s*(.+)$/i);
    if (thicknessMatch) {
      const surfaceIndex = Number(thicknessMatch[1]);
      if (Number.isInteger(surfaceIndex)) {
        const next = pending.get(surfaceIndex) || {
          surfaceIndex,
          radiusPart: '',
          thicknessPart: '',
          embodimentKey: currentEmbodiment.key,
          embodimentLabel: currentEmbodiment.label,
          zoomKey: currentZoom.key,
          zoomLabel: currentZoom.label,
          order: orderCounter += 1,
        };
        next.thicknessPart = `d${surfaceIndex}= ${thicknessMatch[2].trim()}`;
        pending.set(surfaceIndex, next);
        lastThicknessSurfaceIndex = surfaceIndex;
        flushPending(surfaceIndex);
        continue;
      }
    }
  }

  const remaining = Array.from(pending.values())
    .sort((left, right) => left.order - right.order)
    .filter((item) => item.radiusPart || item.thicknessPart);
  for (const item of remaining) {
    const line = `${item.radiusPart} ${item.thicknessPart}`.trim();
    const sanitizedLine = sanitizePatentCandidateLine(line);
    if (!sanitizedLine || seenLines.has(sanitizedLine)) continue;
    const numbers = extractPatentNumbers(sanitizedLine);
    if (numbers.length === 0) continue;
    mergedRows.push({
      line: sanitizedLine,
      numbers,
      embodimentKey: item.embodimentKey,
      embodimentLabel: item.embodimentLabel,
      zoomKey: item.zoomKey,
      zoomLabel: item.zoomLabel,
      surfaceIndex: item.surfaceIndex,
    });
    seenLines.add(sanitizedLine);
  }

  return mergedRows;
}

function parseLiteratureText(input: string): LiteratureExtractResult {
  const text = normalizePatentOcrText(input);

  const patentIds = collectMatches(text, /\b(?:JP|US|EP|WO)[A-Z0-9\-\/]{5,}\b/gi, (value) => value.toUpperCase());
  const sourceUrls = collectMatches(text, /https?:\/\/[^\s)]+/gi);
  const focalLengths = collectNumericGroups(text, /(?:^|\b)(?:f(?:ocal)?(?:\s*length)?|efl|焦点距離)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?/gim);
  const fNumbers = collectNumericGroups(text, /(?:^|\b)(?:f\/?#|fno|f-number|Ｆ値)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?/gim);
  const fieldAngles = collectNumericGroups(text, /(?:^|\b)(?:half\s*angle|field\s*angle|angle\s*of\s*view|画角)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?/gim);
  const imageHeights = collectNumericGroups(text, /(?:^|\b)(?:image\s*height|y'?\s*image|像高)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?(?:\s*[,\/~-]\s*([+-]?\d+(?:\.\d+)?))?/gim);
  const totalLengths = collectNumericGroups(text, /(?:^|\b)(?:total\s*length|overall\s*length|ttl|oal|tl)\s*[:=]?\s*([+-]?\d+(?:\.\d+)?)/gim);
  const glassNames = uniqueStrings([
    ...collectMatches(text, /\b(?:N|S|P|L)?-[A-Z]{1,6}[A-Z0-9-]*\b/g),
    ...collectMatches(text, /\b(?:FUSED\s+SILICA|PMMA|COP|COC|BK7|SF10|LAK\d+|FK\d+)\b/gi, (value) => value.toUpperCase()),
  ]);

  const contextual = parseContextualCandidateRows(text);
  const inferredZooms = buildInferredZoomOptions(focalLengths.length > 0 ? focalLengths : fNumbers);
  const zoomPositions = contextual.zoomPositions.length > 1
    ? contextual.zoomPositions
    : [makeOption('all', 'All'), ...inferredZooms];

  return {
    patentIds,
    sourceUrls,
    focalLengths,
    fNumbers,
    fieldAngles,
    imageHeights,
    totalLengths,
    glassNames,
    embodiments: contextual.embodiments,
    zoomPositions,
    candidateTableRows: contextual.rows,
  };
}

function formatNumberList(values: number[]): string {
  if (!Array.isArray(values) || values.length === 0) return 'n/a';
  return values.map((value) => Number(value).toFixed(Math.abs(value) >= 100 ? 1 : 3).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')).join(', ');
}

function buildLiteratureSummary(query: string, sourceUrl: string, result: LiteratureExtractResult): string {
  const lines: string[] = [];
  const asphereRowCount = countCandidateRowsWithPatentAsphereMarkers(result.candidateTableRows);
  lines.push('[Patent Literature Import Draft]');
  lines.push(`Query: ${query.trim() || 'n/a'}`);
  lines.push(`Source URL: ${sourceUrl.trim() || (result.sourceUrls[0] || 'n/a')}`);
  lines.push(`Patent IDs: ${result.patentIds.length > 0 ? result.patentIds.join(', ') : 'n/a'}`);
  lines.push('');
  lines.push('[Detected Spec Candidates]');
  lines.push(`Focal length(s): ${formatNumberList(result.focalLengths)}`);
  lines.push(`F-number(s): ${formatNumberList(result.fNumbers)}`);
  lines.push(`Field angle(s): ${formatNumberList(result.fieldAngles)}`);
  lines.push(`Image height(s): ${formatNumberList(result.imageHeights)}`);
  lines.push(`Total length(s): ${formatNumberList(result.totalLengths)}`);
  lines.push(`Glass names: ${result.glassNames.length > 0 ? result.glassNames.join(', ') : 'n/a'}`);
  lines.push(`Embodiments: ${result.embodiments.length > 1 ? result.embodiments.filter((option) => option.key !== 'all').map((option) => option.label).join(', ') : 'n/a'}`);
  lines.push(`Zoom positions: ${result.zoomPositions.length > 1 ? result.zoomPositions.filter((option) => option.key !== 'all').map((option) => option.label).join(', ') : 'n/a'}`);
  lines.push(`Asphere rows: ${asphereRowCount > 0 ? String(asphereRowCount) : 'not detected'}`);
  lines.push('');
  lines.push('[Candidate Numeric Rows]');
  if (result.candidateTableRows.length === 0) {
    lines.push('No table-like numeric rows were detected. Paste OCR text or a table excerpt from the PDF.');
  } else {
    result.candidateTableRows.forEach((row, index) => {
      const contextPrefix = [row.embodimentLabel !== 'All' ? row.embodimentLabel : '', row.zoomLabel !== 'All' ? row.zoomLabel : ''].filter(Boolean).join(' / ');
      lines.push(`${index + 1}. ${contextPrefix ? `[${contextPrefix}] ` : ''}${row.line}`);
    });
  }
  lines.push('');
  lines.push('[Next Step]');
  lines.push('Pick one embodiment and one zoom position, then map each numeric row to surface radius / thickness / glass / Abbe before building the optical system.');
  return lines.join('\n');
}

function formatCandidateRowsForEditor(rows: LiteratureCandidateRow[]): string {
  const cleanedRows = cleanupPatentCandidateRows(rows);
  if (cleanedRows.length === 0) return '';
  const uniqueEmbodimentKeys = new Set(cleanedRows.map((row) => String(row?.embodimentKey ?? 'all')));
  const uniqueZoomKeys = new Set(cleanedRows.map((row) => String(row?.zoomKey ?? 'all')));
  const omitContextPrefix = uniqueEmbodimentKeys.size <= 1 && uniqueZoomKeys.size <= 1;
  return cleanedRows.map((row) => {
    const contextPrefix = [row.embodimentLabel !== 'All' ? row.embodimentLabel : '', row.zoomLabel !== 'All' ? row.zoomLabel : '']
      .filter(Boolean)
      .join(' / ');
    return `${!omitContextPrefix && contextPrefix ? `[${contextPrefix}] ` : ''}${sanitizePatentCandidateLine(row.line)}`;
  }).join('\n');
}

function parseCandidateRowsFromEditor(text: string): LiteratureCandidateRow[] {
  const rows: LiteratureCandidateRow[] = [];
  const lines = normalizePatentOcrText(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let currentAsphereSurfaceIndex: number | null = null;
  for (const line of lines) {
    let embodimentLabel = 'All';
    let embodimentKey = 'all';
    let zoomLabel = 'All';
    let zoomKey = 'all';
    let content = line.replace(/^\d+\.\s*/, '').trim();

    const contextMatch = content.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (contextMatch) {
      const contextText = String(contextMatch[1] ?? '').trim();
      content = String(contextMatch[2] ?? '').trim();
      const parts = contextText.split('/').map((part) => part.trim()).filter(Boolean);
      if (parts[0]) {
        const embodiment = normalizeEmbodiment(parts[0]);
        embodimentKey = embodiment.key;
        embodimentLabel = embodiment.label;
      }
      if (parts[1]) {
        const zoom = normalizeZoomPosition(parts[1]);
        zoomKey = zoom.key;
        zoomLabel = zoom.label;
      }
    }

    const surfaceIndexHint = extractPatentSurfaceIndexHint(content);
    if (/非球面|円錐定数|コーニック定数|コニック定数|2次曲面パラメータ|二次曲面パラメータ/i.test(content) && surfaceIndexHint !== null) {
      currentAsphereSurfaceIndex = surfaceIndexHint;
    }

    content = sanitizePatentCandidateLine(content);

    const numbers = (content.match(/[+-]?\d+(?:\.\d+)?/g) ?? [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (numbers.length === 0) continue;
    const asphereTerms = parsePatentAsphereTerms(content);
    const isAsphereContinuation = asphereTerms.hasAny && isPatentAsphereContinuationLine(content);
    rows.push({
      line: content,
      numbers,
      embodimentKey,
      embodimentLabel,
      zoomKey,
      zoomLabel,
      surfaceIndex: surfaceIndexHint ?? (isAsphereContinuation ? currentAsphereSurfaceIndex : null),
    });
  }
  return rows;
}

function mergeCorrectedCandidateRows(baseResult: LiteratureExtractResult, correctedText: string): LiteratureExtractResult {
  const correctedRows = cleanupPatentCandidateRows(parseCandidateRowsFromEditor(correctedText)).map((row, index) => {
    const baseRow = Array.isArray(baseResult.candidateTableRows) ? baseResult.candidateTableRows[index] : null;
    const usesImplicitContext = row.embodimentKey === 'all' && row.zoomKey === 'all' && !!baseRow;
    return usesImplicitContext
      ? {
          ...row,
          embodimentKey: baseRow.embodimentKey,
          embodimentLabel: baseRow.embodimentLabel,
          zoomKey: baseRow.zoomKey,
          zoomLabel: baseRow.zoomLabel,
          surfaceIndex: row.surfaceIndex ?? baseRow.surfaceIndex ?? null,
        }
      : row;
  });
  const correctedGlassNames = uniqueStrings([
    ...baseResult.glassNames,
    ...collectMatches(correctedText, /\b(?:N|S|P|L)?-[A-Z]{1,6}[A-Z0-9-]*\b/g),
    ...collectMatches(correctedText, /\b(?:FUSED\s+SILICA|PMMA|COP|COC|BK7|SF10|LAK\d+|FK\d+)\b/gi, (value) => value.toUpperCase()),
  ]);
  return {
    ...baseResult,
    glassNames: correctedGlassNames,
    candidateTableRows: correctedRows,
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}
  return false;
}

async function loadTextFromPdfBlob(blob: Blob): Promise<string> {
  const { text } = await extractPdfTextLayer(blob);
  return text;
}

async function extractPdfTextLayer(blob: Blob): Promise<{ text: string; pdf: any; pageCount: number }> {
  const buffer = await blob.arrayBuffer();
  const pdfjs = await import('pdfjs-dist');
  const workerModule = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  (pdfjs as any).GlobalWorkerOptions.workerSrc = (workerModule as any).default;

  const loadingTask = (pdfjs as any).getDocument({
    data: buffer,
    useWorkerFetch: false,
    isEvalSupported: false,
    cMapUrl: 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'standard_fonts/',
    BinaryDataFactory: PdfJsBinaryDataFactory,
  });
  const pdf = await loadingTask.promise;
  const pages: string[] = [];
  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex);
    const content = await page.getTextContent();
    const text = (content.items ?? []).map((item: any) => String(item?.str ?? '')).join(' ');
    if (text.trim()) pages.push(text.trim());
  }
  return { text: pages.join('\n\n'), pdf, pageCount: Number(pdf?.numPages || 0) };
}

function createScratchCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function binarizeCanvas(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return;
  try {
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    for (let index = 0; index < data.length; index += 4) {
      const gray = (data[index] * 0.299) + (data[index + 1] * 0.587) + (data[index + 2] * 0.114);
      const value = gray < 190 ? 0 : 255;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  } catch (_) {}
}

function createScaledCropCanvas(
  source: HTMLCanvasElement,
  crop: { x: number; y: number; width: number; height: number },
  outputScale = 1.75
): HTMLCanvasElement {
  const sx = Math.max(0, Math.floor(source.width * crop.x));
  const sy = Math.max(0, Math.floor(source.height * crop.y));
  const sw = Math.max(1, Math.min(source.width - sx, Math.floor(source.width * crop.width)));
  const sh = Math.max(1, Math.min(source.height - sy, Math.floor(source.height * crop.height)));
  const target = createScratchCanvas(Math.max(1, Math.ceil(sw * outputScale)), Math.max(1, Math.ceil(sh * outputScale)));
  const context = target.getContext('2d', { willReadFrequently: true });
  if (!context) return target;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, target.width, target.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(source, sx, sy, sw, sh, 0, 0, target.width, target.height);
  binarizeCanvas(target);
  return target;
}

async function setOcrParameters(worker: any, parameters: Record<string, string>): Promise<void> {
  try {
    if (worker && typeof worker.setParameters === 'function') {
      await worker.setParameters(parameters);
    }
  } catch (_) {}
}

async function runPdfOcr(blob: Blob, options?: { maxPages?: number; onProgress?: (message: string) => void }): Promise<{ text: string; pagesProcessed: number }> {
  const { pdf, pageCount } = await extractPdfTextLayer(blob);
  const requestedMaxPages = Number(options?.maxPages);
  const normalizedPageCount = Math.max(1, Number(pageCount || 0) || 1);
  const maxPages = Number.isFinite(requestedMaxPages) && requestedMaxPages > 0
    ? Math.max(1, Math.min(requestedMaxPages, normalizedPageCount))
    : normalizedPageCount;
  const tesseract = await import('tesseract.js');
  let worker: any = null;

  try {
    worker = await (tesseract as any).createWorker('jpn+eng');
  } catch (error) {
    console.warn('⚠️ [Patent OCR] Failed to initialize jpn+eng OCR, falling back to eng:', error);
    worker = await (tesseract as any).createWorker('eng');
  }

  try {
    const pageTexts: string[] = [];
    await setOcrParameters(worker, { tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    for (let pageIndex = 1; pageIndex <= maxPages; pageIndex += 1) {
      options?.onProgress?.(`Running OCR on page ${pageIndex}/${maxPages}...`);
      const page = await pdf.getPage(pageIndex);
      const pageContent = await page.getTextContent().catch(() => null);
      const pageLayerText = (pageContent?.items ?? []).map((item: any) => String(item?.str ?? '')).join(' ');
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createScratchCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) continue;
      await page.render({ canvasContext: context, viewport }).promise;
      const result = await worker.recognize(canvas);
      const text = String(result?.data?.text ?? '').trim();
      const pageParts = text ? [text] : [];
      const pageContextText = [pageLayerText, text].filter(Boolean).join('\n');
      if (!textContainsPatentRadiusMarkers(pageContextText) && textLooksLikePatentOpticalTable(pageContextText)) {
        options?.onProgress?.(`Running focused radius OCR on page ${pageIndex}/${maxPages}...`);
        await setOcrParameters(worker, { tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        const cropCanvases = [
          createScaledCropCanvas(canvas, { x: 0, y: 0.08, width: 0.46, height: 0.88 }, 2),
          createScaledCropCanvas(canvas, { x: 0, y: 0.12, width: 0.34, height: 0.82 }, 2.35),
        ];
        for (let cropIndex = 0; cropIndex < cropCanvases.length; cropIndex += 1) {
          const cropResult = await worker.recognize(cropCanvases[cropIndex]);
          const cropText = String(cropResult?.data?.text ?? '').trim();
          if (cropText) pageParts.push(`[Focused radius OCR page ${pageIndex}.${cropIndex + 1}]\n${cropText}`);
        }
        await setOcrParameters(worker, { tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
      }
      if (pageParts.length > 0) pageTexts.push(pageParts.join('\n'));
    }
    return { text: pageTexts.join('\n\n'), pagesProcessed: maxPages };
  } finally {
    await worker.terminate();
  }
}

function loadTextFromHtmlText(text: string): string {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(text, 'text/html');
  documentNode.querySelectorAll('script, style, noscript').forEach((element) => element.remove());
  const root = documentNode.querySelector('article, main, body') || documentNode.body;
  return String(root?.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

async function loadTextFromDocumentUrl(url: string): Promise<{ text: string; sourceKind: 'pdf' | 'html' | 'text' }> {
  const trimmedUrl = String(url ?? '').trim();
  if (!trimmedUrl) throw new Error('Document URL is empty.');

  const response = await fetch(trimmedUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Document fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
  if (contentType.includes('pdf') || /\.pdf(?:$|\?)/i.test(trimmedUrl)) {
    const pdfBlob = await response.blob();
    return { text: await loadTextFromPdfBlob(pdfBlob), sourceKind: 'pdf' };
  }

  const text = await response.text();
  if (contentType.includes('html')) {
    return { text: loadTextFromHtmlText(text), sourceKind: 'html' };
  }
  return { text, sourceKind: 'text' };
}

function detectGlassName(line: string, fallbackGlassNames: string[]): string {
  const matched = fallbackGlassNames.find((glassName) => new RegExp(`\\b${glassName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i').test(line));
  if (matched) return matched;
  if (/\bAIR\b/i.test(line)) return 'AIR';
  return '';
}

function isPatentGapCandidateLine(line: string): boolean {
  const text = String(line ?? '').trim();
  if (!text) return false;
  return /^(air|gap|air\s*gap|airspace|space)\b/i.test(text)
    || /\b(gap|air\s*gap|airspace)\b/i.test(text);
}

function isPatentStopCandidateLine(line: string): boolean {
  const text = String(line ?? '').trim();
  if (!text) return false;
  return /\b(stop|aperture)\b/i.test(text) || /絞り/.test(text);
}

function parsePatentNamedValue(line: string, labels: string[]): number | null {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const match = String(line ?? '').match(new RegExp(`(?:^|[^A-Z0-9])(?:${escaped.join('|')})\\s*\
    (?:\\d+\\s*)?[#%*¥]?\\s*[:=]\\s*(${PATENT_NUMBER_SOURCE})`.replace(/\s+/g, ''), 'i'));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parsePatentNamedRawValue(line: string, labels: string[]): string | null {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const valueSource = `(?:INF|INFINITY|∞|可変|${PATENT_NUMBER_SOURCE})`;
  const match = String(line ?? '').match(new RegExp(`(?:^|[^A-Z0-9])(?:${escaped.join('|')})(?:\\s*\\d+)?[#%*¥]?\\s*[:=]\\s*(${valueSource})`, 'i'));
  if (!match) return null;
  const value = String(match[1] ?? '').trim();
  if (!value) return null;
  return isInfLikePatentImport(value) ? 'INF' : value;
}

function hasPatentNamedField(line: string, labels: string[]): boolean {
  const escaped = labels.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?:^|[^A-Z0-9])(?:${escaped.join('|')})(?:\\s*\\d+)?\\s*[#%*¥]?\\s*[:=]`, 'i').test(String(line ?? ''));
}

function isPatentGapRow(row: Record<string, any>): boolean {
  if (!row || typeof row !== 'object') return false;
  if (row._patentImportKind === 'gap') return true;
  const material = String(row.material ?? '').trim().toUpperCase();
  if (material !== 'AIR') return false;
  if (!isInfLikePatentImport(row.radius)) return false;
  const thickness = row.thickness;
  const thicknessNumeric = Number(thickness);
  return isInfLikePatentImport(thickness)
    || isVariableLikePatentImport(thickness)
    || (Number.isFinite(thicknessNumeric) && Math.abs(thicknessNumeric) > 1e-12);
}

function makeOpticalRow(id: number, patch: Record<string, any>): Record<string, any> {
  return {
    id,
    'object type': '',
    surfType: 'Spherical',
    comment: '',
    radius: 'INF',
    optimizeR: '',
    thickness: 0,
    optimizeT: '',
    semidia: '',
    optimizeSemiDia: '',
    material: 'AIR',
    optimizeMaterial: '',
    rindex: '',
    optimizeRI: '',
    abbe: '',
    optimizeAbbe: '',
    conic: '0',
    optimizeConic: '',
    coef1: '',
    optimizeCoef1: '',
    coef2: '',
    optimizeCoef2: '',
    coef3: '',
    optimizeCoef3: '',
    coef4: '',
    optimizeCoef4: '',
    coef5: '',
    optimizeCoef5: '',
    coef6: '',
    optimizeCoef6: '',
    coef7: '',
    optimizeCoef7: '',
    coef8: '',
    optimizeCoef8: '',
    coef9: '',
    optimizeCoef9: '',
    coef10: '',
    optimizeCoef10: '',
    ...patch,
  };
}

function pickSelectedValue(values: number[], option: LiteratureOption | null): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (!option || option.key === 'all') return values[0];
  const zoomIndex = Number(option.zoomIndex);
  if (Number.isInteger(zoomIndex) && zoomIndex >= 0 && zoomIndex < values.length) return values[zoomIndex];
  if (option.key === 'tele') return values[values.length - 1];
  if (option.key === 'mid') return values[Math.floor(values.length / 2)];
  return values[0];
}

async function buildDraftRowsFromSelection(result: LiteratureExtractResult, embodimentKey: string, zoomKey: string): Promise<DraftBuildResult> {
  const glassModule = await import('../../../data/glass.ts');
  const getGlassDataWithSellmeier = (glassModule as any).getGlassDataWithSellmeier as ((name: string) => any) | undefined;

  const zoomOption = result.zoomPositions.find((option) => option.key === zoomKey) || null;
  const filteredCandidates = result.candidateTableRows.filter((row) => {
    const embodimentMatches = embodimentKey === 'all' || row.embodimentKey === embodimentKey || row.embodimentKey === 'all';
    const zoomMatches = zoomKey === 'all' || row.zoomKey === zoomKey || row.zoomKey === 'all';
    return embodimentMatches && zoomMatches;
  });

  const notes: string[] = [];
  const focalLength = pickSelectedValue(result.focalLengths, zoomOption);
  const fNumber = pickSelectedValue(result.fNumbers, zoomOption);
  if (focalLength !== null) notes.push(`Selected focal length: ${focalLength}`);
  if (fNumber !== null) notes.push(`Selected F-number: ${fNumber}`);

  const objectRow = makeOpticalRow(0, {
    'object type': 'Object',
    radius: 'INF',
    thickness: 'INF',
    material: 'AIR',
    comment: 'Draft literature import object surface',
  });

  const draftRows: Array<Record<string, any>> = [];
  for (const candidate of filteredCandidates) {
    let numbers = candidate.numbers.slice();
    if (numbers.length >= 4 && Number.isInteger(numbers[0]) && Math.abs(numbers[0]) <= 200) {
      numbers = numbers.slice(1);
    }

    const isGapLine = isPatentGapCandidateLine(candidate.line);
    const isStopLine = isPatentStopCandidateLine(candidate.line);
    const asphereTerms = parsePatentAsphereTerms(candidate.line);
    if (!isGapLine && asphereTerms.hasAny && isPatentAsphereContinuationLine(candidate.line) && draftRows.length > 0) {
      const targetRow = (() => {
        const targetSurfaceIndex = Number(candidate.surfaceIndex);
        if (Number.isInteger(targetSurfaceIndex) && targetSurfaceIndex > 0) {
          for (let index = draftRows.length - 1; index >= 0; index -= 1) {
            const row = draftRows[index];
            const rowSurfaceIndex = Number(row?._patentSurfaceIndex);
            if (Number.isInteger(rowSurfaceIndex) && rowSurfaceIndex === targetSurfaceIndex) return row;
          }
        }
        return draftRows[draftRows.length - 1];
      })();
      applyPatentAsphereTerms(targetRow, asphereTerms);
      targetRow.comment = `${targetRow.comment} || ${candidate.line}`;
      continue;
    }

    const material = detectGlassName(candidate.line, result.glassNames) || 'AIR';
    const glassData = material && material !== 'AIR' && typeof getGlassDataWithSellmeier === 'function'
      ? getGlassDataWithSellmeier(material)
      : null;

    const hasNamedRadius = hasPatentNamedField(candidate.line, ['r', 'radius']);
    const hasNamedThickness = hasPatentNamedField(candidate.line, ['d', 't', 'thickness']);
    const namedRadiusRaw = parsePatentNamedRawValue(candidate.line, ['r', 'radius']);
    const namedThicknessRaw = parsePatentNamedRawValue(candidate.line, ['d', 't', 'thickness']);
    const namedRindex = parsePatentNamedValue(candidate.line, ['nd', 'n', 'n_d', 'rindex']);
    const namedAbbe = parsePatentNamedValue(candidate.line, ['vd', 'v', 'abbe']);
    const namedRadiusNumeric = namedRadiusRaw !== null ? Number(namedRadiusRaw) : NaN;
    const namedThicknessNumeric = namedThicknessRaw !== null ? Number(namedThicknessRaw) : NaN;
    const namedRadius = namedRadiusRaw !== null
      ? (Number.isFinite(namedRadiusNumeric) ? namedRadiusNumeric : namedRadiusRaw)
      : null;
    const namedThickness = namedThicknessRaw !== null
      ? (Number.isFinite(namedThicknessNumeric) ? namedThicknessNumeric : namedThicknessRaw)
      : null;

    const hasSurfaceGeometry = isGapLine || isStopLine || hasNamedRadius || hasNamedThickness;
    if (!hasSurfaceGeometry && !asphereTerms.hasAny) {
      continue;
    }

    const radius = isGapLine || isStopLine
      ? 'INF'
      : (namedRadius !== null ? String(namedRadius) : (numbers.length > 0 ? String(numbers[0]) : 'INF'));
    let thickness: string | number = isGapLine
      ? (namedThickness !== null ? namedThickness : (numbers.length > 0 ? numbers[0] : 0))
      : isStopLine
        ? (namedThickness !== null ? namedThickness : (numbers.length > 0 ? numbers[numbers.length - 1] : 0))
        : (namedThickness !== null
          ? namedThickness
          : (hasNamedRadius || hasNamedThickness || namedRindex !== null || namedAbbe !== null)
            ? 0
            : (numbers.length > 1 ? numbers[1] : 0));
    let semidia: string | number = '';
    let rindex = namedRindex !== null ? String(namedRindex) : (glassData?.nd ? String(glassData.nd) : '');
    let abbe = namedAbbe !== null ? String(namedAbbe) : (glassData?.vd ? String(glassData.vd) : '');

    const remaining = (hasNamedRadius || hasNamedThickness || namedRindex !== null || namedAbbe !== null)
      ? []
      : numbers.slice(isGapLine ? 1 : 2);
    for (const value of remaining) {
      if (!rindex && value > 1 && value < 3.5) {
        rindex = String(value);
        continue;
      }
      if (!abbe && value > 10 && value < 100) {
        abbe = String(value);
        continue;
      }
      if (semidia === '' && value > 0 && value <= 200) {
        semidia = value;
      }
    }

    const normalizedMaterial = (() => {
      if (isGapLine) return 'AIR';
      if (material !== 'AIR') return material;
      if (rindex) return rindex;
      return 'AIR';
    })();

    if (normalizedMaterial === 'AIR' && !rindex) rindex = '';
    if (normalizedMaterial === 'AIR' && !abbe) abbe = '';

    const draftRow = makeOpticalRow(draftRows.length + 1, {
      'object type': isStopLine ? 'Stop' : '',
      radius,
      thickness,
      semidia,
      material: normalizedMaterial,
      rindex,
      abbe,
      _patentSurfaceIndex: candidate.surfaceIndex ?? null,
      _patentImportKind: isGapLine ? 'gap' : 'surface',
      comment: `${candidate.embodimentLabel}${candidate.zoomLabel !== 'All' ? ` / ${candidate.zoomLabel}` : ''} | ${candidate.line}`,
    });
    applyPatentAsphereTerms(draftRow, asphereTerms);
    draftRows.push(draftRow);
  }

  const imageRow = makeOpticalRow(draftRows.length + 1, {
    'object type': 'Image',
    radius: 'INF',
    thickness: 0,
    material: 'AIR',
    comment: 'Draft literature import image surface',
  });

  if (filteredCandidates.length === 0) {
    notes.push('No candidate numeric rows matched the current embodiment / zoom selection.');
  }

  return {
    rows: [objectRow, ...draftRows, imageRow],
    notes,
  };
}

function formatDraftRows(rows: Array<Record<string, any>>, notes: string[], summary: string): string {
  const lines: string[] = [];
  lines.push('[Optical System Draft Rows]');
  if (notes.length > 0) {
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }
  rows.forEach((row) => {
    lines.push(`${row.id}\t${row['object type'] || ''}\tR=${row.radius}\tT=${row.thickness}\tSD=${row.semidia || ''}\tMAT=${row.material || ''}\tnd=${row.rindex || ''}\tvd=${row.abbe || ''}\t${row.comment || ''}`);
  });
  lines.push('');
  lines.push(summary);
  return lines.join('\n');
}

function countPatentDraftSurfaceRows(rows: Array<Record<string, any>>): number {
  if (!Array.isArray(rows)) return 0;
  return rows.reduce((count, row) => {
    const objectType = String(row?.['object type'] ?? row?.object ?? '').trim().toLowerCase();
    if (objectType === 'object' || objectType === 'image') return count;
    return count + 1;
  }, 0);
}

async function applyDraftToWorkspace(rows: Array<Record<string, any>>, systemDataText: string, mode: 'replace' | 'new' = 'replace'): Promise<{ saved: boolean; blockCount: number }> {
  const [{ loadSystemConfigurations, saveSystemConfigurations, loadActiveConfigurationToTables }, { saveTableData }, { requestRefreshBlockInspector }] = await Promise.all([
    import('../../../data/table-configuration.ts'),
    import('../../../data/table-optical-system.ts'),
    import('../../../core/window-facade.ts'),
  ]);

  let saved = false;
  let blockCount = 0;
  try {
    const systemConfig = loadSystemConfigurations();
    const activeConfig = Array.isArray(systemConfig?.configurations)
      ? systemConfig.configurations.find((config: any) => String(config?.id) === String(systemConfig?.activeConfigId)) || systemConfig.configurations[0]
      : null;
    if (activeConfig) {
      const nowIso = new Date().toISOString();
      const targetConfig = (() => {
        if (mode === 'new') {
          const maxId = Math.max(...systemConfig.configurations.map((config: any) => Number(config?.id) || 0), 0);
          const newId = maxId + 1;
          const importedConfig = JSON.parse(JSON.stringify(activeConfig));
          importedConfig.id = newId;
          importedConfig.name = `${String(activeConfig.name || 'Config')} (Patent Import)`;
          importedConfig.metadata = {
            ...(importedConfig.metadata || {}),
            created: nowIso,
            modified: nowIso,
            designer: {
              type: 'imported',
              name: 'patent-import',
              confidence: null,
            },
          };
          systemConfig.configurations.push(importedConfig);
          systemConfig.activeConfigId = newId;
          return importedConfig;
        }
        return activeConfig;
      })();

      let derivedBlocks = normalizeObjectDistanceInBlocks(buildFallbackBlocksFromRows(rows, false));
      let importAnalyzeMode = false;
      derivedBlocks = attachPatentImportMetadataToBlocks(derivedBlocks, systemDataText, nowIso);
      blockCount = derivedBlocks.length;

      // Imported draft rows become the persisted surface representation.
      // When block derivation succeeds, keep blocks in sync so Design Intent can open.
      // Otherwise fall back to surface-only import/analyze mode.
      targetConfig.blocks = derivedBlocks;
      targetConfig.opticalSystem = rows;
      targetConfig.systemData = {
        ...(targetConfig.systemData || {}),
        literatureImportSummary: systemDataText,
      };
      targetConfig.metadata = {
        ...(targetConfig.metadata && typeof targetConfig.metadata === 'object' ? targetConfig.metadata : {}),
        modified: nowIso,
        importAnalyzeMode,
        literatureImportSummary: systemDataText,
      };
      saveSystemConfigurations(systemConfig);
      saved = true;
    }
  } catch (_) {}

  try {
    saveTableData(rows as any);
  } catch (_) {}

  const w = window as any;
  try {
    if (w.tableOpticalSystem && typeof w.tableOpticalSystem.replaceData === 'function') {
      await w.tableOpticalSystem.replaceData(rows);
    }
  } catch (_) {}

  try {
    if (typeof loadActiveConfigurationToTables === 'function') {
      await loadActiveConfigurationToTables({ applyToUI: true });
    }
  } catch (_) {}

  try {
    if (w.ConfigurationManager && typeof w.ConfigurationManager.loadActiveConfigurationToTables === 'function') {
      await Promise.resolve(w.ConfigurationManager.loadActiveConfigurationToTables({ applyToUI: true }));
    } else if (typeof w.loadActiveConfigurationToTables === 'function') {
      await Promise.resolve(w.loadActiveConfigurationToTables({ applyToUI: true }));
    }
  } catch (_) {}

  try {
    if (typeof requestRefreshBlockInspector === 'function') {
      requestRefreshBlockInspector(window);
    }
  } catch (_) {}

  try {
    if (typeof w.refreshBlockInspector === 'function') {
      w.refreshBlockInspector();
    }
  } catch (_) {}

  try {
    if (w.ConfigurationManager && typeof w.ConfigurationManager.renderBlocksUI === 'function') {
      w.ConfigurationManager.renderBlocksUI();
    }
  } catch (_) {}

  try {
    window.dispatchEvent(new CustomEvent('coopt:system-configurations-updated'));
  } catch (_) {}

  try {
    if (typeof w.__cooptPushSystemDataText === 'function') {
      w.__cooptPushSystemDataText(systemDataText);
    }
  } catch (_) {}

  return { saved, blockCount };
}

const PATENT_AI_KEY_STORAGE = 'coopt.patentAi.geminiKey';
const PATENT_AI_MODEL_STORAGE = 'coopt.patentAi.model';

type PatentSourceImage = {
  dataUrl: string;
  mimeType: string;
  name: string;
};

export function LiteratureImportPanel() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('zoom lens');
  const [sourceUrl, setSourceUrl] = useState('');
  const [rawText, setRawText] = useState('');
  const [summary, setSummary] = useState('');
  const [draftPreview, setDraftPreview] = useState('');
  const [status, setStatus] = useState('Load a patent URL or paste OCR text, then extract and build a draft.');
  const [result, setResult] = useState<LiteratureExtractResult | null>(null);
  const [selectedEmbodiment, setSelectedEmbodiment] = useState('all');
  const [selectedZoom, setSelectedZoom] = useState('all');
  const [draftRows, setDraftRows] = useState<Array<Record<string, any>>>([]);
  const [candidateRowsText, setCandidateRowsText] = useState('');
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [isRunningOcr, setIsRunningOcr] = useState(false);
  const [sourcePdfBlob, setSourcePdfBlob] = useState<Blob | null>(null);
  const [sourceImage, setSourceImage] = useState<PatentSourceImage | null>(null);
  const [aiApiKey, setAiApiKey] = useState<string>(() => {
    try { return localStorage.getItem(PATENT_AI_KEY_STORAGE) ?? ''; } catch { return ''; }
  });
  const [aiModel, setAiModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(PATENT_AI_MODEL_STORAGE) ?? '';
      // Migrate deprecated models to current equivalent
      if (!saved || saved === 'gemini-2.5-flash' || saved === 'gemini-2.0-flash' || saved === 'gemini-1.5-pro' || saved === 'gemma-3-27b-it') return 'gemini-3.1-pro-preview';
      return saved;
    } catch { return 'gemini-3.1-pro-preview'; }
  });
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [isAiProcessing, setIsAiProcessing] = useState(false);

  const openSearch = (target: 'google-patents' | 'jplatpat') => {
    const nextQuery = query.trim() || 'zoom lens patent';
    const url = target === 'google-patents'
      ? `https://patents.google.com/?q=${encodeURIComponent(nextQuery)}`
      : `https://www.google.com/search?q=${encodeURIComponent(`site:j-platpat.inpit.go.jp ${nextQuery}`)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const rebuildDraft = async (nextResult: LiteratureExtractResult, embodimentKey: string, zoomKey: string, nextSummary: string) => {
    const draft = await buildDraftRowsFromSelection(nextResult, embodimentKey, zoomKey);
    setDraftRows(draft.rows);
    setDraftPreview(formatDraftRows(draft.rows, draft.notes, nextSummary));
    return draft;
  };

  const rebuildDraftFromCurrentCandidateRows = async (): Promise<{ rows: Array<Record<string, any>>; summaryText: string; surfaceCount: number } | null> => {
    if (!result) {
      const surfaceCount = countPatentDraftSurfaceRows(draftRows);
      return {
        rows: draftRows,
        summaryText: summary || draftPreview,
        surfaceCount,
      };
    }

    const correctedResult = candidateRowsText.trim()
      ? mergeCorrectedCandidateRows(result, candidateRowsText)
      : result;
    if (correctedResult.candidateTableRows.length === 0) {
      setStatus('No numeric candidate rows are available. Run Extract Candidate Data or restore Correct Candidate Rows before applying.');
      return null;
    }

    const nextSummary = buildLiteratureSummary(query, sourceUrl, correctedResult);
    let nextEmbodiment = correctedResult.embodiments.find((option) => option.key === selectedEmbodiment)?.key
      || correctedResult.embodiments.find((option) => option.key !== 'all')?.key
      || 'all';
    let nextZoom = correctedResult.zoomPositions.find((option) => option.key === selectedZoom)?.key
      || correctedResult.zoomPositions.find((option) => option.key !== 'all')?.key
      || 'all';
    let draft = await buildDraftRowsFromSelection(correctedResult, nextEmbodiment, nextZoom);

    if (countPatentDraftSurfaceRows(draft.rows) === 0 && (nextEmbodiment !== 'all' || nextZoom !== 'all')) {
      const allDraft = await buildDraftRowsFromSelection(correctedResult, 'all', 'all');
      if (countPatentDraftSurfaceRows(allDraft.rows) > 0) {
        nextEmbodiment = 'all';
        nextZoom = 'all';
        draft = {
          rows: allDraft.rows,
          notes: ['Selected embodiment / zoom had no surface rows; using all corrected candidate rows.', ...allDraft.notes],
        };
      }
    }

    setResult(correctedResult);
    setSummary(nextSummary);
    setCandidateRowsText(formatCandidateRowsForEditor(correctedResult.candidateTableRows));
    setSelectedEmbodiment(nextEmbodiment);
    setSelectedZoom(nextZoom);
    setDraftRows(draft.rows);
    setDraftPreview(formatDraftRows(draft.rows, draft.notes, nextSummary));
    return {
      rows: draft.rows,
      summaryText: nextSummary,
      surfaceCount: countPatentDraftSurfaceRows(draft.rows),
    };
  };

  const handleEmbodimentChange = async (value: string) => {
    setSelectedEmbodiment(value);
    if (!result) return;
    const draft = await rebuildDraft(result, value, selectedZoom, summary);
    setStatus(`Updated patent selection. ${countPatentDraftSurfaceRows(draft.rows)} surface row(s) are ready.`);
  };

  const handleZoomChange = async (value: string) => {
    setSelectedZoom(value);
    if (!result) return;
    const draft = await rebuildDraft(result, selectedEmbodiment, value, summary);
    setStatus(`Updated patent selection. ${countPatentDraftSurfaceRows(draft.rows)} surface row(s) are ready.`);
  };

  const handleRunOcr = async (mode: 'replace' | 'append' = 'append') => {
    if (!sourcePdfBlob) {
      setStatus('Load or paste a PDF first. OCR runs on the current PDF source.');
      return null;
    }

    setIsRunningOcr(true);
    setStatus('Preparing OCR...');
    try {
      const ocrResult = await runPdfOcr(sourcePdfBlob, {
        onProgress: (message) => setStatus(message),
      });
      const ocrText = String(ocrResult.text ?? '').trim();
      if (!ocrText) {
        setStatus('OCR finished, but no text was recognized. The PDF may require higher-resolution OCR or different language data.');
        return '';
      }

      const combinedText = mode === 'replace' || !rawText.trim()
        ? ocrText
        : `${rawText.trim()}\n\n[OCR Fallback]\n${ocrText}`;
      setRawText(combinedText);
      setStatus(`OCR finished for ${ocrResult.pagesProcessed} page(s). Run Extract Candidate Data again.`);
      return combinedText;
    } catch (error) {
      const message = String((error as any)?.message || error || 'Unknown error');
      setStatus(`OCR failed: ${message}`);
      return null;
    } finally {
      setIsRunningOcr(false);
    }
  };

  const handleLoadFromUrl = async () => {
    const url = sourceUrl.trim();
    if (!url) {
      setStatus('Enter a document URL first.');
      return;
    }

    setIsLoadingUrl(true);
    setSourcePdfBlob(null);
    setStatus('Fetching document and extracting text...');
    try {
      const loaded = await loadTextFromDocumentUrl(url);
      setRawText(loaded.text);
      setStatus(`Loaded ${loaded.sourceKind.toUpperCase()} text (${loaded.text.length.toLocaleString()} chars). Run Extract Candidate Data next.`);
    } catch (error) {
      const message = String((error as any)?.message || error || 'Unknown error');
      setStatus(`URL load failed: ${message}. Many patent sites block browser fetch by CORS. Use Open Search, then paste the PDF file or choose it with Select PDF.`);
    } finally {
      setIsLoadingUrl(false);
    }
  };

  const handlePdfFile = async (file: File | Blob | null | undefined) => {
    if (!file) return;
    setIsLoadingPdf(true);
    setSourcePdfBlob(file);
    setSourceImage(null);
    setStatus('Reading PDF file...');
    try {
      const text = await loadTextFromPdfBlob(file);
      setRawText(text);
      if (text.trim().length < 80) {
        setStatus('PDF text layer is sparse. Running OCR fallback...');
        const ocrText = await handleRunOcr('replace');
        if (ocrText && String(ocrText).trim()) return;
      }
      setStatus(`Loaded PDF text (${text.length.toLocaleString()} chars). Run Extract Candidate Data next.`);
    } catch (error) {
      const message = String((error as any)?.message || error || 'Unknown error');
      setStatus(`PDF load failed: ${message}`);
    } finally {
      setIsLoadingPdf(false);
    }
  };

  const handlePdfInputChange = async (event: any) => {
    const file = event?.target?.files?.[0] as File | undefined;
    await handlePdfFile(file);
    if (event?.target) event.target.value = '';
  };

  const handleImageFile = async (file: File | Blob | null | undefined) => {
    if (!file) return;
    const mimeType = String((file as any)?.type || 'image/png');
    if (!/^image\//i.test(mimeType)) {
      setStatus('Select or paste an image file for screenshot AI extraction.');
      return;
    }
    setIsAiProcessing(true);
    setStatus('Reading screenshot image...');
    try {
      const dataUrl = await readBlobAsDataUrl(file);
      const name = String((file as any)?.name || 'pasted screenshot');
      setSourceImage({ dataUrl, mimeType, name });
      setStatus(`Loaded screenshot image (${name}). Click AI Enhance to extract surface and asphere data.`);
    } catch (error) {
      const message = String((error as any)?.message || error || 'Unknown error');
      setStatus(`Image load failed: ${message}`);
    } finally {
      setIsAiProcessing(false);
    }
  };

  const handleImageInputChange = async (event: any) => {
    const file = event?.target?.files?.[0] as File | undefined;
    await handleImageFile(file);
    if (event?.target) event.target.value = '';
  };

  const extractPdfFileFromTransfer = (transfer: DataTransfer | null | undefined): File | null => {
    const items = Array.from(transfer?.items ?? []);
    const pdfItem = items.find((item: any) => item?.kind === 'file' && /pdf/i.test(String(item?.type ?? '')));
    if (pdfItem?.getAsFile) return pdfItem.getAsFile();

    const files = Array.from(transfer?.files ?? []);
    return files.find((file: File) => /pdf/i.test(String(file.type ?? '')) || /\.pdf$/i.test(file.name)) ?? null;
  };

  const extractImageFileFromTransfer = (transfer: DataTransfer | null | undefined): File | null => {
    const items = Array.from(transfer?.items ?? []);
    const imageItem = items.find((item: any) => item?.kind === 'file' && /^image\//i.test(String(item?.type ?? '')));
    if (imageItem?.getAsFile) return imageItem.getAsFile();

    const files = Array.from(transfer?.files ?? []);
    return files.find((file: File) => /^image\//i.test(String(file.type ?? '')) || /\.(?:png|jpe?g|webp)$/i.test(file.name)) ?? null;
  };

  const extractPdfFileFromClipboard = (clipboardData: DataTransfer | null | undefined): File | null => {
    return extractPdfFileFromTransfer(clipboardData);
  };

  const extractImageFileFromClipboard = (clipboardData: DataTransfer | null | undefined): File | null => {
    return extractImageFileFromTransfer(clipboardData);
  };

  const handlePanelDragOver = (event: any) => {
    const file = extractPdfFileFromTransfer(event?.dataTransfer) || extractImageFileFromTransfer(event?.dataTransfer);
    if (!file) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handlePanelDrop = async (event: any) => {
    const pdfFile = extractPdfFileFromTransfer(event?.dataTransfer);
    const imageFile = !pdfFile ? extractImageFileFromTransfer(event?.dataTransfer) : null;
    if (!pdfFile && !imageFile) return;
    event.preventDefault();
    event.stopPropagation();
    if (pdfFile) await handlePdfFile(pdfFile);
    else await handleImageFile(imageFile);
  };

  const handleRawTextPaste = async (event: any) => {
    const pdfFile = extractPdfFileFromClipboard(event?.clipboardData);
    const imageFile = !pdfFile ? extractImageFileFromClipboard(event?.clipboardData) : null;
    if (!pdfFile && !imageFile) return;
    event.preventDefault();
    if (pdfFile) await handlePdfFile(pdfFile);
    else await handleImageFile(imageFile);
  };

  useEffect(() => {
    const handleWindowPasteCapture = (event: ClipboardEvent) => {
      const panel = panelRef.current;
      if (!panel || panel.offsetParent === null) return;
      const pdfFile = extractPdfFileFromClipboard(event.clipboardData);
      const imageFile = !pdfFile ? extractImageFileFromClipboard(event.clipboardData) : null;
      if (!pdfFile && !imageFile) return;
      event.preventDefault();
      event.stopPropagation();
      if (pdfFile) void handlePdfFile(pdfFile);
      else void handleImageFile(imageFile);
    };

    window.addEventListener('paste', handleWindowPasteCapture, true);
    return () => {
      window.removeEventListener('paste', handleWindowPasteCapture, true);
    };
  }, []);

  const handleExtract = async () => {
    let nextText = rawText.trim();
    if (!nextText) {
      setStatus('Paste literature text first.');
      return;
    }

    let nextResult = parseLiteratureText(nextText);
    let nextSummary = buildLiteratureSummary(query, sourceUrl, nextResult);
    const lacksAsphereContent = !textContainsPatentAsphereMarkers(nextText) && !candidateRowsContainPatentAsphereMarkers(nextResult.candidateTableRows);
    const lacksRadiusContent = !textContainsPatentRadiusMarkers(nextText) && !candidateRowsContainPatentRadiusMarkers(nextResult.candidateTableRows);
    if ((nextResult.candidateTableRows.length === 0 || lacksAsphereContent || lacksRadiusContent) && sourcePdfBlob && !isRunningOcr) {
      setStatus(
        nextResult.candidateTableRows.length === 0
          ? 'No candidate rows found from text layer. Running OCR fallback...'
          : lacksRadiusContent
            ? 'No radius column detected from the current PDF text. Running full-document OCR fallback...'
            : 'No asphere section detected from the current PDF text. Running full-document OCR fallback...'
      );
      const ocrCombinedText = await handleRunOcr('append');
      if (ocrCombinedText && String(ocrCombinedText).trim()) {
        nextText = String(ocrCombinedText).trim();
        nextResult = parseLiteratureText(nextText);
        nextSummary = buildLiteratureSummary(query, sourceUrl, nextResult);
      }
    }
    const nextEmbodiment = nextResult.embodiments.find((option) => option.key !== 'all')?.key || 'all';
    const nextZoom = nextResult.zoomPositions.find((option) => option.key !== 'all')?.key || 'all';
    setResult(nextResult);
    setSummary(nextSummary);
    setCandidateRowsText(formatCandidateRowsForEditor(nextResult.candidateTableRows));
    setSelectedEmbodiment(nextEmbodiment);
    setSelectedZoom(nextZoom);
    const draft = await rebuildDraft(nextResult, nextEmbodiment, nextZoom, nextSummary);
    setStatus(`Extracted ${nextResult.candidateTableRows.length} candidate row(s) and built ${countPatentDraftSurfaceRows(draft.rows)} draft surface row(s).`);
  };

  const handleApplyCorrectedCandidateRows = async () => {
    const correctedText = candidateRowsText.trim();
    if (!correctedText && !result) {
      setStatus('Run Extract Candidate Data or AI Enhance first.');
      return;
    }

    const baseResult = result || parseLiteratureText(correctedText || rawText);
    const correctedResult = correctedText
      ? mergeCorrectedCandidateRows(baseResult, correctedText)
      : baseResult;
    if (correctedResult.candidateTableRows.length === 0) {
      setStatus('No numeric candidate rows remain after correction.');
      return;
    }

    const nextSummary = buildLiteratureSummary(query, sourceUrl, correctedResult);
    const nextEmbodiment = correctedResult.embodiments.find((option) => option.key === selectedEmbodiment)?.key
      || correctedResult.embodiments.find((option) => option.key !== 'all')?.key
      || 'all';
    const nextZoom = correctedResult.zoomPositions.find((option) => option.key === selectedZoom)?.key
      || correctedResult.zoomPositions.find((option) => option.key !== 'all')?.key
      || 'all';
    setResult(correctedResult);
    setSummary(nextSummary);
    setSelectedEmbodiment(nextEmbodiment);
    setSelectedZoom(nextZoom);
    const draft = await rebuildDraft(correctedResult, nextEmbodiment, nextZoom, nextSummary);
    const surfaceCount = countPatentDraftSurfaceRows(draft.rows);
    if (surfaceCount === 0) {
      setStatus('Applied corrected candidate rows, but no surface rows were built. Check r/d rows before applying.');
      return;
    }
    const applied = await applyDraftToWorkspace(draft.rows, nextSummary);
    setStatus(
      applied.saved
        ? `Applied corrected rows and built Design Intent (${surfaceCount} surface row(s), ${applied.blockCount} block(s)).`
        : 'Corrected rows were parsed, but Design Intent could not be saved. Check console for configuration storage errors.'
    );
  };

  const handleSaveAiSettings = () => {
    const key = aiApiKey.trim();
    const model = aiModel.trim() || 'gemini-3.1-pro-preview';
    try { localStorage.setItem(PATENT_AI_KEY_STORAGE, key); } catch { /* ignore */ }
    try { localStorage.setItem(PATENT_AI_MODEL_STORAGE, model); } catch { /* ignore */ }
    setAiModel(model);
    setShowAiSettings(false);
    setStatus(key ? 'AI settings saved. You can now use AI Enhance.' : 'AI settings saved (no API key set).');
  };

  const handleAiEnhance = async () => {
    const key = aiApiKey.trim();
    if (!key) {
      setShowAiSettings(true);
      setStatus('Enter your Gemini API key first (free at aistudio.google.com).');
      return;
    }
    const candidateText = candidateRowsText.trim();
    const sourceText = rawText.trim();
    if (!candidateText && !sourceText && !sourceImage) {
      setStatus('Paste patent text, paste/select a screenshot, or run Extract Candidate Data first.');
      return;
    }

    setIsAiProcessing(true);
    setStatus(sourceImage ? 'Sending screenshot to AI... (this may take 10–30 seconds)' : 'Sending to AI... (this may take 10–30 seconds)');
    try {
      const model = (aiModel.trim() || 'gemini-3.1-pro-preview');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const sourceExcerpts = collectPatentAiSourceExcerpts(sourceText);
      const sourceHasAsphereMarkers = textContainsPatentAsphereMarkers(sourceText);
      const imageInlineData = sourceImage ? dataUrlToGeminiInlineData(sourceImage.dataUrl, sourceImage.mimeType) : null;

      const systemPrompt = `You are an expert optical design engineer extracting lens prescriptions from patent OCR text.

    Your job has TWO independent passes:
    1. Surface prescription pass: find every optical surface row containing curvature radius, thickness/spacing, refractive index, and Abbe number.
    2. Asphere pass: scan the ENTIRE source text for aspheric data sections, even if they are far away from the radius table. This pass is mandatory. Look for Japanese and English markers such as 非球面データ, 非球面, 非球面係数, 第N面, 円錐定数, コーニック定数, コニック定数, 2次曲面パラメータ, epsilon, conic, K, k, cc, A4, A6, A8, A10, A12, A14, A16, A18, A20, C4, C6, C8, D4, D6, D8, 4th order, 6th order, 8th order.

    Do not stop after the radius table. Many patents list aspheric coefficients in a separate later table. If the excerpts contain any asphere-like marker, your output must include the corresponding asphere lines unless no numeric coefficients are present.

    Output ONLY normalized data lines. No markdown, no explanations, no table headers.

    Surface row format:
    rN={radius}  dN={thickness}  NN={refractiveIndex}  vN={abbeNumber}

    Examples:
    r1=24.380  d1=1.500  N1=1.80518  v1=25.4
    r2=10.980  d2=0.100
    r4=10.000

    Asphere output MUST use this parser-compatible two-line format:
    第N面の非球面係数
    epsilon={conic} A4={value} A6={value} A8={value} A10={value} A12={value} A14={value} A16={value} A18={value} A20={value}

    If the source writes coefficients as C4/C6/C8, B4/B6/B8, D4/D6/D8, coefficient 4/6/8, or 4th/6th/8th order, normalize them to A4/A6/A8. Treat tables titled 非球面データ exactly like 非球面係数 tables.

    Asphere rules:
    - Use the real surface number N from the source text, e.g. 第6面 or 6th surface.
    - Put coefficient orders exactly as A4, A6, A8, A10, A12, A14, A16, A18, A20.
    - Use epsilon for conic/K/cc/2次曲面パラメータ/円錐定数.
    - If conic is absent, omit epsilon.
    - Include only coefficients explicitly present in the source.
    - Do not attach the surface number to coefficient names. Correct: A4=1e-5. Wrong: A64=1e-5 or A6_4=1e-5.

    General rules:
    - Use = between symbol and value.
    - Convert scientific notation like 1×10^-5, 1 x 10 -5, 1.23E-006 to e notation.
    - Fix obvious OCR mistakes: rl3 -> r13, l/|/I in numeric labels -> 1, N5-1.84666 -> N5=1.84666.
    - Preserve numeric precision as much as possible.
    - Do not invent missing values. If a value is not present, omit that field.
    - If you see an incomplete trailing fragment such as a lone r, ignore it.

    Image/screenshot rules:
    - If an image is provided, read the image directly. Use the visible table structure, not OCR text guesses alone.
    - For Japanese 面データ tables, columns usually mean 面番号 / r / d / nd / vd. A star after a surface number means that surface is aspheric.
    - For Japanese 非球面データ sections, pair each 第N面 block with the following k/epsilon line and A4/A6/A8... coefficient lines.
    - If a row has 可変 in the d column, output dN=可変.
    - If the radius is ∞, output rN=INF.`;

      const userPrompt = `Extract and correct the optical surface and aspheric data from the following patent source. If a screenshot image is attached, prioritize the visual table content and use the text only as supplementary context.

    [Already extracted candidate rows, may be incomplete]
    ${candidateText || '(none)'}

    [Asphere-focused excerpts from full patent OCR/source text]
    ${sourceExcerpts || '(none)'}

    [Attached screenshot]
    ${sourceImage ? `${sourceImage.name} (${sourceImage.mimeType})` : '(none)'}`;

      const userParts: any[] = [{ text: userPrompt }];
      if (imageInlineData?.data) {
        userParts.push({ inline_data: { mime_type: imageInlineData.mimeType, data: imageInlineData.data } });
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: userParts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = (err as any)?.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`Gemini API error: ${msg}`);
      }

      const data = await response.json();
      const aiText: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!aiText.trim()) throw new Error('AI returned empty response');

      setCandidateRowsText(aiText.trim());
      const aiResult = parseCandidateRowsFromEditor(aiText);
      const aiFoundAsphere = candidateRowsContainPatentAsphereMarkers(aiResult);
      setStatus(
        (sourceHasAsphereMarkers || sourceImage) && !aiFoundAsphere
          ? 'AI enhancement complete, but no asphere coefficients were detected in the AI output. The source contains asphere markers; try AI Enhance again or paste the asphere coefficient section into the text box.'
          : 'AI enhancement complete. Review the Correct Candidate Rows, then click Apply Corrected Rows.'
      );
    } catch (error) {
      const msg = String((error as any)?.message ?? error ?? 'Unknown error');
      setStatus(`AI Enhance failed: ${msg}`);
    } finally {
      setIsAiProcessing(false);
    }
  };

  const handleApplyDraftAsNewConfig = async () => {
    const draft = await rebuildDraftFromCurrentCandidateRows();
    if (!draft) return;
    if (draft.rows.length === 0) {
      setStatus('Extract candidate data first.');
      return;
    }
    if (draft.surfaceCount === 0) {
      setStatus('No surface rows were built. Check Correct Candidate Rows for r/d rows before applying.');
      return;
    }
    const applied = await applyDraftToWorkspace(draft.rows, draft.summaryText, 'new');
    setStatus(
      applied.saved
        ? `Patent optical system rows applied as a new Design Intent configuration (${draft.surfaceCount} surface row(s), ${applied.blockCount} block(s)).`
        : 'Patent optical system rows were parsed, but the new Design Intent configuration could not be saved.'
    );
  };

  return (
    <div
      ref={panelRef}
      className="literature-import-section"
      onDragOver={handlePanelDragOver}
      onDrop={(event) => void handlePanelDrop(event)}
    >
    <div className="literature-import-panel">
      <div className="literature-import-panel__header">
        <div>
          <h3>Patent Import</h3>

      <SystemDataPanel />
          <p>Independent workspace tab for semi-automatic patent import: load URL text when allowed, or paste/select a PDF file, then choose embodiment / zoom position and apply the extracted optical system directly.</p>
        </div>
        <div className="literature-import-panel__actions">
          <button type="button" onClick={() => openSearch('jplatpat')}>Search J-PlatPat</button>
          <button type="button" onClick={() => openSearch('google-patents')}>Search Google Patents</button>
        </div>
      </div>

      <div className="literature-import-panel__grid">
        <label>
          <span>Search Keywords</span>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="zoom lens, JP patent number, applicant..."
          />
        </label>
        <label>
          <span>Document URL</span>
          <input
            type="text"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://patents.google.com/... or PDF URL"
          />
        </label>
      </div>

      <div className="literature-import-panel__actions literature-import-panel__actions--primary">
        <button type="button" onClick={handleLoadFromUrl} disabled={isLoadingUrl}>{isLoadingUrl ? 'Loading URL...' : 'Load URL Text'}</button>
        <label className="literature-import-panel__fileButton">
          <input type="file" accept="application/pdf,.pdf" onChange={handlePdfInputChange} />
          <span>{isLoadingPdf ? 'Loading PDF...' : 'Select PDF'}</span>
        </label>
        <label className="literature-import-panel__fileButton">
          <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImageInputChange} />
          <span>Select Screenshot</span>
        </label>
        <button type="button" onClick={() => void handleRunOcr('append')} disabled={isRunningOcr || !sourcePdfBlob}>{isRunningOcr ? 'Running OCR...' : 'Run OCR'}</button>
        <button type="button" onClick={() => setRawText(LITERATURE_IMPORT_EXAMPLE)}>Use Example</button>
      </div>

      {sourceImage ? (
        <div className="literature-import-panel__imagePreview">
          <img src={sourceImage.dataUrl} alt="Patent screenshot for AI extraction" />
          <div>
            <strong>{sourceImage.name}</strong>
            <span>{sourceImage.mimeType}</span>
            <button type="button" onClick={() => setSourceImage(null)}>Clear Screenshot</button>
          </div>
        </div>
      ) : null}

      <label className="literature-import-panel__field">
        <span>Paste PDF Text / OCR, PDF File, or Screenshot</span>
        <textarea
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          onPaste={handleRawTextPaste}
          rows={8}
          placeholder="Paste patent text, table rows, OCR output, or copy a PDF/screenshot and paste it here..."
        />
      </label>
      <div className="literature-import-panel__hint">Direct URL loading works only for documents the browser is allowed to fetch. For image PDFs, use Run OCR. For patent table screenshots, paste or select the image, then use AI Enhance.</div>

      <div className="literature-import-panel__actions literature-import-panel__actions--primary">
        <button type="button" onClick={handleExtract}>Extract Candidate Data</button>
        <button type="button" onClick={handleApplyCorrectedCandidateRows} disabled={!result && !candidateRowsText.trim()}>Apply Corrected Rows</button>
        <button
          type="button"
          onClick={() => void handleAiEnhance()}
          disabled={isAiProcessing}
          title="Use Gemini AI (free) to fix OCR errors and extract surface data"
        >
          {isAiProcessing ? 'AI Processing...' : '✨ AI Enhance'}
        </button>
        <button type="button" onClick={handleApplyDraftAsNewConfig}>Apply as New Config</button>
        <button
          type="button"
          onClick={() => setShowAiSettings((v) => !v)}
          title="Configure free Gemini API key for AI Enhance"
          style={{ marginLeft: 'auto', opacity: 0.7, fontSize: '0.85em' }}
        >
          ⚙ AI Key
        </button>
      </div>

      {showAiSettings && (
        <div className="literature-import-panel__ai-settings">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '0.85em', whiteSpace: 'nowrap' }}>
              Gemini API Key{' '}
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.9em' }}>
                (free at aistudio.google.com)
              </a>
            </label>
            <input
              type="password"
              value={aiApiKey}
              onChange={(e) => setAiApiKey(e.target.value)}
              placeholder="AIza..."
              style={{ flex: '1 1 200px', minWidth: 0 }}
            />
            <select
              value={aiModel}
              onChange={(e) => setAiModel(e.target.value)}
              style={{ minWidth: '160px' }}
              title="Gemini model to use"
            >
              <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (latest, high accuracy)</option>
              <option value="gemini-2.5-flash">gemini-2.5-flash (fast, free)</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro (high accuracy)</option>
              <option value="gemini-2.0-flash-lite">gemini-2.0-flash-lite (lightweight)</option>
              <option value="gemini-1.5-flash">gemini-1.5-flash (legacy)</option>
            </select>
            <button type="button" onClick={handleSaveAiSettings}>Save</button>
            <button type="button" onClick={() => setShowAiSettings(false)} style={{ opacity: 0.6 }}>Cancel</button>
          </div>
          <div style={{ fontSize: '0.8em', color: '#666', marginTop: '4px' }}>
            Key is stored in browser localStorage only. Free tier: 15 req/min, 1500/day. Keys are never sent to any server other than Google.
          </div>
        </div>
      )}

      <div className="literature-import-panel__status">{status}</div>

      {result ? (
        <div className="literature-import-panel__chips" aria-label="Extracted counts">
          <span>{result.patentIds.length} patent id(s)</span>
          <span>{result.glassNames.length} glass name(s)</span>
          <span>{result.candidateTableRows.length} table row(s)</span>
          <span>{countCandidateRowsWithPatentAsphereMarkers(result.candidateTableRows)} asphere row(s)</span>
          <span>{result.focalLengths.length} focal length candidate(s)</span>
        </div>
      ) : null}

      {result ? (
        <div className="literature-import-panel__grid literature-import-panel__grid--selectors">
          <label>
            <span>Embodiment</span>
            <select value={selectedEmbodiment} onChange={(event) => { void handleEmbodimentChange(event.target.value); }}>
              {result.embodiments.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Zoom Position</span>
            <select value={selectedZoom} onChange={(event) => { void handleZoomChange(event.target.value); }}>
              {result.zoomPositions.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <label className="literature-import-panel__field">
        <span>Correct Candidate Rows</span>
        <textarea
          value={candidateRowsText}
          onChange={(event) => setCandidateRowsText(event.target.value)}
          rows={12}
          placeholder="Correct OCR typos here, then click Apply Corrected Rows..."
        />
      </label>
      <div className="literature-import-panel__hint">Edit only the extracted candidate rows here. You can fix OCR typos like `rl3` to `r13`, `N5-1.84666` to `N5=1.84666`, or malformed decimals, then click Apply Corrected Rows.</div>
    </div>
    </div>
  );
}

export function SystemDataPanel({ visible = false }: { visible?: boolean }) {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const w = window as any;
    const storageKey = 'coopt.systemDataText';
    const getOpenerSystemDataText = () => {
      try {
        const opener = w.opener;
        if (!opener || opener.closed) return '';
        return typeof opener.__cooptSystemDataText === 'string' ? opener.__cooptSystemDataText : '';
      } catch (_) {
        return '';
      }
    };
    const hasLiveWavefrontRuntime = () => {
      try {
        const runtime = w.__cooptLastWavefrontRuntime;
        const map = runtime && typeof runtime === 'object' ? runtime.map : null;
        return !!(map && typeof map === 'object' && !map.error);
      } catch (_) {
        return false;
      }
    };

    const applySystemDataText = (text: any) => {
      const next = String(text ?? '');
      try {
        w.__cooptSystemDataText = next;
      } catch (_) {}
      try {
        localStorage.setItem(storageKey, next);
      } catch (_) {}
      try {
        const ta = document.getElementById('system-data') as HTMLTextAreaElement | null;
        if (ta && ta.value !== next) ta.value = next;
      } catch (_) {}
    };

    const prev = w.__cooptPushSystemDataText;
    w.__cooptPushSystemDataText = applySystemDataText;

    // Only bootstrap cached System Data when there is a live wavefront runtime.
    // Otherwise stale Zernike text can survive file loads and look like fresh output.
    let initial = '';
    if (hasLiveWavefrontRuntime()) {
      try {
        if (typeof w.__cooptSystemDataText === 'string') initial = w.__cooptSystemDataText;
      } catch (_) {}
      if (!initial) {
        try {
          const cached = localStorage.getItem(storageKey);
          if (typeof cached === 'string') initial = cached;
        } catch (_) {}
      }
    } else {
      initial = getOpenerSystemDataText();
    }

    if (initial) applySystemDataText(initial);

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      applySystemDataText(event.newValue ?? '');
    };

    window.addEventListener('storage', handleStorage);

    return () => {
      try {
        window.removeEventListener('storage', handleStorage);
      } catch (_) {}
      try {
        if (w.__cooptPushSystemDataText === applySystemDataText) {
          if (typeof prev === 'function') w.__cooptPushSystemDataText = prev;
          else delete w.__cooptPushSystemDataText;
        }
      } catch (_) {}
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || typeof window === 'undefined') return;

    const w = window as any;
    const hasOpener = (() => {
      try {
        return !!(w.opener && !w.opener.closed);
      } catch (_) {
        return false;
      }
    })();
    if (hasOpener) {
      return;
    }
    const getOpenerSystemDataText = () => {
      try {
        const opener = w.opener;
        if (!opener || opener.closed) return '';
        return typeof opener.__cooptSystemDataText === 'string' ? opener.__cooptSystemDataText : '';
      } catch (_) {
        return '';
      }
    };
    const hasLiveWavefrontRuntime = () => {
      try {
        const runtime = w.__cooptLastWavefrontRuntime;
        const map = runtime && typeof runtime === 'object' ? runtime.map : null;
        return !!(map && typeof map === 'object' && !map.error);
      } catch (_) {
        return false;
      }
    };
    let cancelled = false;
    let attempts = 0;
    let timer: number | null = null;
    const hasExistingSystemDataText = () => {
      const hasLiveRuntime = hasLiveWavefrontRuntime();
      const openerText = getOpenerSystemDataText();
      try {
        const ta = document.getElementById('system-data') as HTMLTextAreaElement | null;
        if (ta && String(ta.value || '').trim().length > 0) {
          return hasLiveRuntime || openerText.trim().length > 0;
        }
      } catch (_) {}
      if (openerText.trim().length > 0) {
        return true;
      }
      if (!hasLiveRuntime) {
        return false;
      }
      try {
        if (typeof w.__cooptSystemDataText === 'string' && w.__cooptSystemDataText.trim().length > 0) {
          return true;
        }
      } catch (_) {}
      try {
        const cached = localStorage.getItem('coopt.systemDataText');
        if (typeof cached === 'string' && cached.trim().length > 0) return true;
      } catch (_) {}
      return false;
    };

    if (!hasLiveWavefrontRuntime() && getOpenerSystemDataText().trim().length === 0) {
      try {
        w.__cooptSystemDataText = '';
      } catch (_) {}
      try {
        localStorage.removeItem('coopt.systemDataText');
      } catch (_) {}
      try {
        const ta = document.getElementById('system-data') as HTMLTextAreaElement | null;
        if (ta) ta.value = '';
      } catch (_) {}
    }

    if (hasExistingSystemDataText()) {
      return;
    }

    const runInitialParaxial = () => {
      if (cancelled) return;
      attempts += 1;

      try {
        const ta = document.getElementById('system-data') as HTMLTextAreaElement | null;
        if (ta && attempts === 1) {
          ta.value = '';
        }
      } catch (_) {}

      try {
        if (typeof w.outputParaxialDataToDebug === 'function') {
          w.outputParaxialDataToDebug(w.tableOpticalSystem ?? null);
          return;
        }
      } catch (_) {}

      if (attempts < 20) {
        timer = window.setTimeout(runInitialParaxial, 100);
      }
    };

    timer = window.setTimeout(runInitialParaxial, 0);

    return () => {
      cancelled = true;
      if (timer !== null) {
        try {
          window.clearTimeout(timer);
        } catch (_) {}
      }
    };
  }, [visible]);

  return (
    <div className={`system-section ${visible ? 'system-section-window-fit' : ''}`} style={{ display: visible ? 'flex' : 'none' }}>
      <div
        id="transform-error-bar"
        className="merit-function-help"
        style={{ display: 'none', borderLeftColor: '#dc3545', marginBottom: 10 }}
      >
        <strong>Error:</strong> <span id="transform-error-text"></span>
      </div>

      <div
        id="transform-progress-wrapper"
        style={{
          display: 'none',
          padding: '8px 12px',
          borderBottom: '1px solid #eee',
          background: '#fff',
          marginBottom: 10,
        }}
      >
        <div id="transform-progress-text">Calculating...</div>
        <progress id="transform-progressbar" max={100} value={0} style={{ width: '100%', marginTop: 4 }}></progress>
      </div>

      <div className="system-controls">
        <button id="calculate-paraxial-btn">Calculate Paraxial</button>
        <button id="calculate-seidel-btn">Aberration Coefficients</button>
        <button id="calculate-seidel-afocal-btn">Aberration Coefficients (Afocal)</button>
        <label htmlFor="reference-focal-length">Reference Focal Length:</label>
        <input type="text" id="reference-focal-length" placeholder="Auto" style={{ width: '80px' }} />
        <button id="coord-transform-btn">Coord Transform</button>
      </div>
      <textarea id="system-data" rows={15} cols={100}></textarea>
    </div>
  );
}

export default function LegacyPanels() {
  useEffect(() => {
    // Re-initialize event listeners when component mounts
    if (typeof window !== 'undefined') {
      const meritEditor = (window as any).meritFunctionEditor;
      if (meritEditor && typeof meritEditor.initializeEventListeners === 'function') {
        meritEditor.initializeEventListeners();
      }
    }
  }, []);

  // React-style Merit Function button handlers
  const handleAddOperand = () => {
    console.log('[LegacyPanels] Add Term button clicked (React handler)');
    const editor = (window as any).meritFunctionEditor;
    if (editor && typeof editor.addOperand === 'function') {
      editor.addOperand();
    } else {
      console.error('[LegacyPanels] Merit Function Editor or addOperand method not available');
    }
  };

  const handleDeleteOperand = () => {
    console.log('[LegacyPanels] Delete Term button clicked (React handler)');
    const editor = (window as any).meritFunctionEditor;
    if (editor && typeof editor.deleteOperand === 'function') {
      editor.deleteOperand();
    } else {
      console.error('[LegacyPanels] Merit Function Editor or deleteOperand method not available');
    }
  };

  const handleCalculateMerit = () => {
    console.log('[LegacyPanels] Calculate Evaluation button clicked (React handler)');
    const editor = (window as any).meritFunctionEditor;
    if (editor && typeof editor.calculateMerit === 'function') {
      editor.calculateMerit();
    } else {
      console.error('[LegacyPanels] Merit Function Editor or calculateMerit method not available');
    }
  };

  return (
    <>
      <div className="merit-function-section" style={{ display: "none" }}>
        <h2>System Evaluation</h2>
        <div className="merit-function-help">
          <strong>Note:</strong> This evaluation encodes design intent. Optimization is optional and always explicit.
          <br />
          <strong>Terminology / 用語:</strong>
          Target = requirement value（要求値／目標の数字）, Weight = scoring weight（評価の重み／採点上の重要度）.
        </div>
        <div className="merit-function-buttons-container">
          <button onClick={handleAddOperand}>Add Term</button>
          <button onClick={handleDeleteOperand}>Delete Term</button>
          <button onClick={handleCalculateMerit}>Calculate Evaluation</button>
        </div>
        <div id="table-merit-function"></div>
        <div className="merit-summary">
          <strong>Requirements Score:</strong> <span id="total-merit-value">0.000</span>
        </div>
        <div id="operand-inspector" className="operand-inspector" style={{ display: "none" }}>
          <h3>Evaluation Detail / Inspector</h3>
          <div id="inspector-content"></div>
        </div>

        <div id="block-contribution-section" className="block-contribution-section" style={{ display: "none" }}>
          <h3>Block Contribution Summary</h3>
          <div className="merit-function-help">
            <strong>Note:</strong> Updated when running “Aberration Coefficients”. Aggregated by expanded-row provenance (_blockId).
          </div>
          <textarea
            id="block-contribution-summary"
            rows={10}
            cols={100}
            readOnly
            placeholder="Block contribution summary will appear here..."
          ></textarea>
        </div>
      </div>
      {false && (
      <div className="draw-system-container">
        <div className="draw-section">
          <div id="threejs-canvas-container" aria-label="Optical system 3D canvas" />

          <div className="spot-diagram-section" style={{ display: "none" }}>
            <h2>Spot Diagram</h2>
            <div className="spot-diagram-controls">
              <label htmlFor="surface-number-select">Surface number:</label>
              <select id="surface-number-select">
                <option value="">Select surface...</option>
              </select>
              <label htmlFor="ray-count-input">Ray number:</label>
              <input type="number" id="ray-count-input" defaultValue={128} min={1} max={10001} step={1} />
              <label htmlFor="ring-count-select">Ring count:</label>
              <select id="ring-count-select" defaultValue="10">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
                <option value="4">4</option>
                <option value="5">5</option>
                <option value="6">6</option>
                <option value="7">7</option>
                <option value="8">8</option>
                <option value="9">9</option>
                <option value="10">10</option>
                <option value="12">12</option>
                <option value="15">15</option>
                <option value="16">16</option>
                <option value="20">20</option>
                <option value="24">24</option>
                <option value="32">32</option>
              </select>
              <span className="ray-count-note ring-count-note">(Limited by available rays)</span>

              <div className="ray-pattern-controls">
                <label>Ray pattern:</label>
                <button id="annular-pattern-btn" className="pattern-btn active">
                  Annular
                </button>
                <button id="grid-pattern-btn" className="pattern-btn">
                  Rectangle
                </button>
              </div>

              <button id="show-spot-diagram-btn" title="Generate spot diagram for the selected surface">
                Show spot diagram
              </button>
            </div>
            <div className="spot-diagram-help">
              <strong>Note:</strong>
              • Select a surface where rays can reach (usually Image surface or earlier)
              • If you get "rays not reaching surface" error, try selecting an earlier surface
              • Higher ray count provides better accuracy but takes longer to compute
            </div>
            <div id="spot-diagram-container"></div>
          </div>

          <div className="longitudinal-aberration-section" style={{ display: "none" }}>
            <h2>Spherical Aberration Diagram</h2>
            <div className="longitudinal-aberration-help">
              <strong>Note:</strong> Spherical aberration shows the axial displacement of focus along the optical axis (X-axis: longitudinal aberration, Y-axis: normalized pupil coordinate).
            </div>
            <div className="longitudinal-aberration-controls">
              <label htmlFor="longitudinal-ray-count-input">Ray number:</label>
              <input type="number" id="longitudinal-ray-count-input" defaultValue={100} min={1} max={1001} step={1} />
              <span className="note">(Always normalized by stop diameter)</span>
              <label htmlFor="longitudinal-reference-focus-mode" style={{ marginLeft: 10 }}>Reference focus:</label>
              <select id="longitudinal-reference-focus-mode" defaultValue="current-paraxial">
                <option value="primary-paraxial">Primary paraxial</option>
                <option value="current-paraxial">Current paraxial</option>
                <option value="chief-ray">Chief ray</option>
              </select>
              <button id="show-longitudinal-aberration-diagram-btn">Show spherical aberration diagram</button>
            </div>
            <div id="longitudinal-aberration-container"></div>
          </div>

          <div className="transverse-aberration-section" style={{ display: "none" }}>
            <h2>Transverse Aberration Diagram</h2>
            <div className="transverse-aberration-controls">
              <label htmlFor="transverse-ray-count-input">Ray number:</label>
              <input type="number" id="transverse-ray-count-input" defaultValue={21} min={9} max={10001} step={1} />
              <span className="note">(Always normalized by stop diameter)</span>
              <button id="show-transverse-aberration-diagram-btn">Show transverse aberration diagram</button>
            </div>
            <div id="transverse-aberration-container"></div>
          </div>

          <div className="astigmatism-section" style={{ display: "none" }}>
            <h2>Astigmatism Diagram</h2>
            <div className="astigmatism-help">
              <strong>Note:</strong> Astigmatism diagram shows the sagittal and meridional focal positions across different field angles.
            </div>
            <div className="astigmatism-controls">
              <label htmlFor="astigmatism-chief-ray-mode" style={{ marginRight: 8 }}>
                Chief Ray Definition:
              </label>
              <select id="astigmatism-chief-ray-mode" defaultValue="stopCenter">
                <option value="stopCenter">① 絞り中央通過 (Stop Center)</option>
                <option value="beamCenter">② 光束巾の真ん中 (Beam Center)</option>
                <option value="centroid">③ 光束の重心 (Centroid)</option>
              </select>
              <label htmlFor="astigmatism-point-count-input" style={{ marginLeft: 10 }}>Points:</label>
              <input type="number" id="astigmatism-point-count-input" defaultValue={21} min={2} max={201} step={1} />
              <label htmlFor="astigmatism-ray-count-input" style={{ marginLeft: 10 }}>Rays:</label>
              <input type="number" id="astigmatism-ray-count-input" defaultValue={101} min={9} max={2001} step={1} />
              <label htmlFor="astigmatism-ring-count-input" style={{ marginLeft: 10 }}>Rings:</label>
              <input type="number" id="astigmatism-ring-count-input" defaultValue={256} min={1} max={1024} step={1} />
              <label htmlFor="astigmatism-focus-range-input" style={{ marginLeft: 10 }}>Focus (+/- mm):</label>
              <input type="number" id="astigmatism-focus-range-input" defaultValue={0.4} min={0} step={0.01} />
              <button id="show-astigmatism-diagram-btn" style={{ marginLeft: 12 }}>Show astigmatism diagram</button>
            </div>
            <div id="astigmatism-progress-wrapper" style={{ display: "none", margin: "8px 0" }}>
              <div id="astigmatism-progress-text" style={{ marginBottom: 6, fontSize: 12, color: "#333" }}>
                Calculating astigmatism...
              </div>
              <progress id="astigmatism-progressbar" max={100} value={0} style={{ width: "100%" }}></progress>
            </div>
            <div id="astigmatism-container"></div>
            <div id="astigmatic-field-curves-container"></div>
          </div>

          <div className="distortion-section" style={{ display: "none" }}>
            <h2>Distortion Diagram</h2>
            <div className="distortion-help">
              <strong>Note:</strong> Distortion shows the deviation of real image height from ideal (paraxial) image height.
              Field angles are automatically detected from Object table.
            </div>
            <div className="distortion-controls">
              <label htmlFor="enlargement-factor-input" style={{ marginRight: 8 }}>
                Enlargement Factor:
              </label>
              <input id="enlargement-factor-input" type="number" defaultValue={1} step="0.1" style={{ width: 72, marginRight: 12 }} />
              <button id="show-distortion-diagram-btn">Show distortion diagram</button>
            </div>
            <div id="distortion-percent"></div>
          </div>

          <div className="distortion-grid-section" style={{ display: "none" }}>
            <h2>Distortion Grid</h2>
            <div className="distortion-help">
              <strong>Note:</strong> Distortion Grid plots ideal grid lines and traced image points.
            </div>
            <div className="distortion-controls">
              <label htmlFor="grid-size-select" style={{ marginLeft: 20 }}>
                Grid Size:
              </label>
              <select id="grid-size-select" defaultValue="20">
                <option value="10">10×10</option>
                <option value="15">15×15</option>
                <option value="20">20×20</option>
                <option value="25">25×25</option>
                <option value="30">30×30</option>
                <option value="35">35×35</option>
                <option value="40">40×40</option>
                <option value="45">45×45</option>
                <option value="50">50×50</option>
              </select>
              <button id="show-distortion-grid-btn">Show grid distortion</button>
            </div>
            <div id="distortion-grid"></div>
          </div>

          <div className="magnification-chromatic-aberration-section" style={{ display: "none" }}>
            <h2>Lateral Chromatic Aberration</h2>
            <div className="magnification-chromatic-aberration-help">
              <strong>Note:</strong> Lateral displacement is plotted relative to the primary wavelength at each object value.
            </div>
            <div className="magnification-chromatic-aberration-controls">
              <label htmlFor="mca-xrange-input">Lateral displacement (+/- mm):</label>
              <input type="number" id="mca-xrange-input" defaultValue={0.04} min={0} step={0.01} />
              <span className="note">(mm)</span>
              <label htmlFor="mca-point-count-input" style={{ marginLeft: 10 }}>Points:</label>
              <input type="number" id="mca-point-count-input" defaultValue={21} min={2} max={201} step={1} />
              <label htmlFor="mca-ray-count-input" style={{ marginLeft: 10 }}>Rays:</label>
              <input type="number" id="mca-ray-count-input" defaultValue={101} min={1} max={5001} step={1} />
              <label htmlFor="mca-ring-count-input" style={{ marginLeft: 10 }}>Rings:</label>
              <input type="number" id="mca-ring-count-input" defaultValue={30} min={1} max={99} step={1} />
              <label htmlFor="mca-chief-ray-definition" style={{ marginLeft: 10 }}>Chief ray:</label>
              <select id="mca-chief-ray-definition" defaultValue="stop-center">
                <option value="stop-center">Stop center</option>
                <option value="beam-centroid">Beam centroid</option>
              </select>
              <label htmlFor="mca-smoothing-adjacent-points-input" style={{ marginLeft: 10 }}>Smooth N:</label>
              <input type="number" id="mca-smoothing-adjacent-points-input" defaultValue={1} min={0} max={50} step={1} />
              <button id="show-magnification-chromatic-aberration-btn">Show lateral chromatic aberration</button>
            </div>
            <div id="mca-progress-wrapper" style={{ display: "none", margin: "8px 0" }}>
              <div id="mca-progress-text" style={{ marginBottom: 6, fontSize: 12, color: "#333" }}>
                Calculating lateral chromatic aberration...
              </div>
              <progress id="mca-progressbar" max={100} value={0} style={{ width: "100%" }}></progress>
            </div>
            <div id="magnification-chromatic-aberration-container"></div>
          </div>

          <section className="diagram-section" style={{ display: "none" }}>
            <h2>Integrated Aberration Diagram</h2>
            <div className="distortion-help">
              <strong>Note:</strong> This diagram combines Spherical Aberration, Astigmatic Field Curves, and Distortion in one view.
            </div>
            <div className="distortion-controls">
              <button id="show-integrated-aberration-btn">Show integrated aberration diagram</button>
            </div>
          </section>

          <div className="wavefront-aberration-section" style={{ display: "none" }}>
            <h2>Optical Path Difference</h2>
            <div className="wavefront-aberration-controls">
              <label htmlFor="wavefront-object-select">Object:</label>
              <select id="wavefront-object-select">
                <option value="0">Object 1</option>
                <option value="1">Object 2</option>
                <option value="2">Object 3</option>
                <option value="3">Object 4</option>
                <option value="4">Object 5</option>
              </select>
              <label htmlFor="wavefront-plot-type-select">Plot type:</label>
              <select id="wavefront-plot-type-select">
                <option value="surface">3D Surface</option>
                <option value="heatmap">Heatmap</option>
                <option value="multifield">Multi-field Comparison</option>
              </select>
              <label htmlFor="wavefront-grid-size-select">Grid size:</label>
              <select id="wavefront-grid-size-select" defaultValue="64">
                <option value="16">16x16</option>
                <option value="32">32x32</option>
                <option value="64">64x64</option>
                <option value="128">128x128</option>
                <option value="256">256x256</option>
              </select>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" id="opd-remove-ptd-checkbox" />
                Remove P/T/D
              </label>
              <button id="show-wavefront-diagram-btn">Show wavefront diagram</button>
              <button id="stop-opd-btn" type="button" disabled>
                Stop
              </button>
              <button id="zernike-fit-btn">Zernike Fit</button>
            </div>
            <div id="opd-progress" style={{ margin: "8px 0", fontSize: 13, color: "#666" }}></div>
            <div id="wavefront-container"></div>
            <div id="wavefront-container-stats"></div>
          </div>

          <div className="psf-section" style={{ display: "none" }}>
            <h2>Point Spread Function</h2>
            <div className="psf-controls">
              <label htmlFor="psf-object-select">Object:</label>
              <select id="psf-object-select">
                <option value="0">Object 1</option>
              </select>
              <label htmlFor="psf-sampling-select">FFT grid:</label>
              <select id="psf-sampling-select" defaultValue="64">
                <option value="32">32x32</option>
                <option value="64">64x64</option>
                <option value="128">128x128</option>
                <option value="256">256x256</option>
                <option value="512">512x512</option>
                <option value="1024">1024x1024</option>
                <option value="2048">2048x2048</option>
                <option value="4096">4096x4096</option>
              </select>
              <label
                htmlFor="psf-zeropad-select"
                title="Zero-padding increases PSF sampling resolution by enlarging FFT size without increasing OPD ray grid."
              >
                Zero pad:
              </label>
              <select
                id="psf-zeropad-select"
                title="Auto: pad to at least 512. None: no padding (fast). Or choose an explicit FFT size."
                defaultValue="auto"
              >
                <option value="auto">Auto (≥512)</option>
                <option value="none">None</option>
                <option value="512">512</option>
                <option value="1024">1024</option>
                <option value="2048">2048</option>
                <option value="4096">4096</option>
              </select>
              <label htmlFor="psf-zernike-sampling-select">OPD grid:</label>
              <select
                id="psf-zernike-sampling-select"
                title="Ray-traced OPD grid size (number of rays traced across pupil)"
                defaultValue="64"
              >
                <option value="32">32x32</option>
                <option value="64">64x64</option>
                <option value="128">128x128</option>
                <option value="256">256x256</option>
                <option value="512">512x512</option>
                <option value="1024">1024x1024</option>
                <option value="2048">2048x2048</option>
                <option value="4096">4096x4096</option>
              </select>
              <label>
                <input type="checkbox" id="psf-log-scale-checkbox" />
                Log scale
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <input type="checkbox" id="psf-remove-ptd-checkbox" />
                Remove P/T/D
              </label>
              <label htmlFor="psf-performance-select">Calculator:</label>
              <select id="psf-performance-select" defaultValue="auto">
                <option value="auto">Auto (WASM preferred)</option>
                <option value="wasm">Force WASM</option>
                <option value="javascript">Force JavaScript</option>
              </select>
              <button id="show-psf-btn" title="Calculate and display PSF from OPD data">
                Show PSF
              </button>
              <button id="stop-psf-btn" title="Stop the current PSF calculation" disabled>
                Stop
              </button>
              <span id="psf-pipeline-badge" title="PSF execution route">
                Unified pipeline: Ready
              </span>
            </div>
            <div className="psf-help" style={{ fontSize: 12, color: "#666", margin: "10px 0" }}>
              <strong>Note:</strong> PSF is calculated from OPD data using Fourier transform. Generate OPD data first using the Optical Path Difference section above.
            </div>
            <div id="psf-container"></div>
            <div id="psf-container-stats"></div>
            <div
              id="psf-benchmark-results"
              style={{
                marginTop: 10,
                padding: 10,
                border: "1px solid #ddd",
                borderRadius: 5,
                display: "none",
              }}
            >
              <h4>Benchmark Results</h4>
              <div id="psf-benchmark-details"></div>
            </div>
          </div>
        </div>
      </div>
      )}

      <footer
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 8,
          padding: "12px 0",
          fontSize: 12,
        }}
      >
        <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 12 }}>
          <a
            href="https://x.com/yassan_8"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="X profile: @yassan_8"
            title="X: @yassan_8"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none" }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false" style={{ display: "block" }}>
              <path
                fill="currentColor"
                d="M18.9 2H22l-6.8 7.8L23 22h-6.7l-5.2-6.7L5.3 22H2l7.4-8.5L1 2h6.8l4.7 6.1L18.9 2zm-1.2 18h1.7L7.1 3.9H5.3L17.7 20z"
              />
            </svg>
            <span>@yassan_8</span>
          </a>
          <span style={{ opacity: 0.8 }}>Contact: For inquiries, please reach out via X.</span>
        </div>
        <div
          style={{
            fontSize: 11,
            textAlign: "center",
            maxWidth: 800,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 2,
          }}
        >
          <div style={{ color: "black" }}>
            <strong>Privacy Policy:</strong> We use Google Analytics to improve our service, but no personally identifiable information is collected.
          </div>
          <div style={{ color: "black" }}>Also, your design data is processed locally and never sent to our server.</div>
        </div>
      </footer>
    </>
  );
}

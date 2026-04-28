const PATENT_NUMBER_SOURCE = '[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?';

function parsePatentAsphereTerms(line) {
  const text = String(line ?? '');
  const coefficients = {};
  let surfType = null;

  let conic = null;
  const conicPatterns = [
    new RegExp(`(?:^|[^A-Z0-9])(?:conic\\s*constant|conic|cc|k)\\s*[:=]?\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
    new RegExp(`\\bK\\s*=\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
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
    const value = Number(match[2]);
    if (!Number.isFinite(order) || !Number.isFinite(value)) continue;
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

  return {
    hasAny: conic !== null || Object.keys(coefficients).length > 0,
    conic,
    surfType,
    coefficients,
  };
}

const sample = 'G1 34.12 -28.45 4.20 N-BK7 64.17';
try {
    console.log('Testing sample:', sample);
    const result = parsePatentAsphereTerms(sample);
    console.log('Result:', JSON.stringify(result, null, 2));
} catch (e) {
    console.error('Exception thrown:', e);
}

function extractPatentNumbers(text) {
  const PATENT_NUMBER_SOURCE = '[+\-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+\-]?\d+)?';
  const PATENT_NUMBER_PATTERN = new RegExp(PATENT_NUMBER_SOURCE, 'gi');
  return (String(text ?? '').match(PATENT_NUMBER_PATTERN) ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function isPatentAsphereContinuationLine(line) {
  // Logic from LegacyPanels.tsx wasn't fully read, but we can assume it's simple
  // or just check if it's called.
  return /^\s*(?:A[3-9]|A1[0-9]|A2[0-2]|coef|conic|cc|k)\b/i.test(line);
}

const lines = [
    'Example data:',
    'G1 34.12 -28.45 4.20 N-BK7 64.17'
];

console.log('\nTesting full candidate extraction logic:');
for (const line of lines) {
    console.log('Line:', line);
    const numbers = extractPatentNumbers(line);
    const asphereTerms = parsePatentAsphereTerms(line);
    // Mimicking the logic in LegacyPanels.tsx:
    // const isAsphereContinuation = asphereTerms.hasAny && isPatentAsphereContinuationLine(line);
    // if ((!isAsphereContinuation && numbers.length < 3) || numbers.length > 16) continue;
    
    console.log('  Numbers:', numbers);
    console.log('  AsphereTerms.hasAny:', asphereTerms.hasAny);
    
    const condition = (asphereTerms.hasAny && isPatentAsphereContinuationLine(line)) || (numbers.length >= 3 && numbers.length <= 16);
    console.log('  Accepted as candidate:', condition);
}

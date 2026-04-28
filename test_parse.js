const PATENT_NUMBER_SOURCE = '[+\\-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+\\-]?\\d+)?';

const PATENT_OCR_REPLACEMENTS = [
  [/\brl(?=\d)/g, 'r1'],
  [/\bdl(?=\d)/g, 'd1'],
  [/\bvl(?=\d)/g, 'v1'],
  [/\bNl(?=\d)/g, 'N1'],
  [/\bM[Il](?=\s*=|\s*[-:]\s*(?=\d))/g, 'N1'],
  [/\bM(\d+)\s*[-:]\s*(?=\d)/g, 'N$1='],
  [/\br(\d+)%\s*=/gi, 'r$1='],
  [/\br(\d+)[#*¥]\s*=/gi, 'r$1='],
  [/\bd(\d+)%\s*=/gi, 'd$1='],
  [/\bd(\d+)[#*¥]\s*=/gi, 'd$1='],
  [/\bv(\d+)%\s*=/gi, 'v$1='],
  [/\bN(\d+)\s*[-:]\s*(?=\d)/g, 'N$1='],
  [/(^|\s)0(?=\d{1,2}\s*=)/gm, '$1d'],
  [/(^|\s)O(?=\d{1,2}\s*=)/gm, '$1d'],
  [/^(\d{1,2})\s*=(?=\s*[+\-]?\d)/gm, 'd$1='],
  [/([εϵ∈])\s*=/g, 'epsilon='],
  [/\b[Oo](?=\d+(?:\.\d+)?\b)/g, '0'],
  [/\bINF\s+INF\b/g, 'INF d='],
];

function normalizePatentOcrText(input) {
  let text = String(input ?? '')
    .replace(/[\u3000\t]+/g, ' ')
    .replace(/[−–—]/g, '-')
    .replace(/[，]/g, ',')
    .replace(new RegExp(`(${PATENT_NUMBER_SOURCE})\\s*[×xX*]\\s*10\\s*\\^?\\s*([+\\-]?\\d+|[“”"])`, 'gi'), (match, num, exp) => {
       const cleanExp = exp.replace(/[“”"]/g, '');
       return cleanExp ? `${num}e${cleanExp}` : num;
    })
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

function parsePatentAsphereTerms(line) {
  const text = String(line ?? '');
  const coefficients = {};
  let surfType = null;
  let conic = null;
  const conicPatterns = [
    new RegExp(`(?:^|[^A-Z0-9])(?:conic\\s*constant|conic|cc|k)\\s*[:=]?\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
    new RegExp(`\\bK\\s*=\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
    new RegExp(`(?:^|[^A-Z0-9])(?:epsilon|ε|ϵ|2次曲面パラメータ|二次曲面パラメータ)\\s*[:=：]?\\s*(${PATENT_NUMBER_SOURCE})`, 'i'),
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

  const orderPattern = new RegExp(`\\b(?:A|Ad|AL|r|d|v|N|M|E|F|G|H|I|J|K|L|P|Q|S|T|U|V|W|Z)\\s*(3|4|5|6|7|8|9|10|11|12|13|14|15|16|17|18|19|20|21|22)\\s*[:=]?\\s*(${PATENT_NUMBER_SOURCE})`, 'gi');
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
  return { conic, coefficients, surfType, hasAny: conic !== null || Object.keys(coefficients).length > 0 };
}

const lines = [
  "[Wide] [0030] 40 Ad= 0.23422721 x 10”",
  "[Wide] A6= 0.22222019 x 10”",
  "[Wide] AL4--0.15349438 x 10\"",
  "[Wide] M=0.98407854 x 10”",
  "[Wide] &= 0.0000",
  "[Wide] g= 1.0000",
  "[Wide] 【0039】[ 第 16 面 (16) の 非 球面 係数 |"
];

const results = lines.map(line => {
  const normalized = normalizePatentOcrText(line);
  const parsed = parsePatentAsphereTerms(normalized);
  return { original: line, normalized, parsed };
});

console.log(JSON.stringify(results, null, 2));

/**
 * Add manufacturer field to all glass entries in glass.js
 */

import fs from 'fs';

const filePath = '../data/glass.js';
let content = fs.readFileSync(filePath, 'utf8');

// Define manufacturer patterns with their database patterns
const manufacturers = [
  { name: 'OHARA', pattern: /export const oharaGlassDB = \[[\s\S]*?\n\];/g, dbName: 'oharaGlassDB' },
  { name: 'SCHOTT', pattern: /export const schottGlassDB = \[[\s\S]*?\n\];/g, dbName: 'schottGlassDB' },
  { name: 'HOYA', pattern: /export const hoyaGlassDB = \[[\s\S]*?\n\];/g, dbName: 'hoyaGlassDB' },
  { name: 'Sumita', pattern: /export const sumitaGlassDB = \[[\s\S]*?\n\];/g, dbName: 'sumitaGlassDB' },
  { name: 'CDGM', pattern: /export const cdgmGlassDB = \[[\s\S]*?\n\];/g, dbName: 'cdgmGlassDB' }
];

console.log('Adding manufacturer field to glass databases...\n');

manufacturers.forEach(({ name, pattern, dbName }) => {
  console.log(`Processing ${name} (${dbName})...`);
  
  const match = content.match(pattern);
  if (!match) {
    console.log(`  ⚠️ Database ${dbName} not found`);
    return;
  }
  
  let dbContent = match[0];
  let count = 0;
  
  // Add manufacturer field to each glass entry that doesn't already have it
  // Pattern: find "name": followed by "nd": without "manufacturer": in between
  const glassEntryPattern = /(\{\s*\n\s*"name":\s*"[^"]+",\s*\n\s*"nd":\s*[\d.]+,\s*\n\s*"vd":\s*[\d.]+,)(\s*\n)/g;
  
  dbContent = dbContent.replace(glassEntryPattern, (match, beforeVd, after) => {
    // Check if manufacturer already exists
    if (!beforeVd.includes('"manufacturer"')) {
      count++;
      return beforeVd + `\n    "manufacturer": "${name}",` + after;
    }
    return match;
  });
  
  content = content.replace(pattern, dbContent);
  console.log(`  ✅ Added manufacturer to ${count} glasses`);
});

// Write back to file
fs.writeFileSync(filePath, content, 'utf8');
console.log('\n✅ All manufacturers added successfully!');

/**
 * Check and remove duplicate "manufacturer" fields in glass.js
 */

import fs from 'fs';

const filePath = './data/glass.js';
let content = fs.readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log('Checking for duplicate "manufacturer" fields...\n');

let totalDuplicates = 0;
let currentGlassStart = null;
let manufacturerLines = [];
let inGlassObject = false;
let bracketCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  // Track if we're inside a glass object
  if (line.includes('"name":')) {
    currentGlassStart = i;
    manufacturerLines = [];
    inGlassObject = true;
    bracketCount = 0;
  }
  
  if (inGlassObject) {
    // Count brackets to know when object ends
    bracketCount += (line.match(/{/g) || []).length;
    bracketCount -= (line.match(/}/g) || []).length;
    
    // Check for manufacturer field
    if (line.includes('"manufacturer":')) {
      manufacturerLines.push(i);
    }
    
    // When object closes, check for duplicates
    if (bracketCount <= 0 && currentGlassStart !== null) {
      if (manufacturerLines.length > 1) {
        const glassName = lines[currentGlassStart].match(/"name":\s*"([^"]+)"/)?.[1];
        console.log(`Found duplicate manufacturer in glass "${glassName}" (lines ${manufacturerLines.join(', ')})`);
        totalDuplicates++;
        
        // Keep only the first occurrence, mark others for deletion
        for (let j = 1; j < manufacturerLines.length; j++) {
          lines[manufacturerLines[j]] = ''; // Mark for deletion
        }
      }
      
      // Reset for next glass object
      currentGlassStart = null;
      manufacturerLines = [];
      inGlassObject = false;
    }
  }
}

if (totalDuplicates > 0) {
  console.log(`\n⚠️ Found ${totalDuplicates} glasses with duplicate manufacturer fields`);
  console.log('Removing duplicates...');
  
  // Remove empty lines and fix spacing
  const cleanedLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '' && lines[i-1]?.trim().endsWith(',')) {
      // Skip empty line that was a duplicate manufacturer
      continue;
    }
    cleanedLines.push(lines[i]);
  }
  
  content = cleanedLines.join('\n');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('✅ Duplicates removed successfully!');
} else {
  console.log('✅ No duplicate manufacturer fields found!');
}

console.log('\nFinal verification...');
// Count total manufacturer fields
const totalManufacturers = (content.match(/"manufacturer":/g) || []).length;
console.log(`Total "manufacturer" fields: ${totalManufacturers}`);

import fs from 'fs';
import { expandBlocksToOpticalSystemRows, validateBlocksConfiguration } from './data/block-schema.ts';

const jsonPath = '/Users/masanori/Downloads/20260421_Paraxial_3枚.json';
const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// Correct nesting: rawData.configurations.configurations
const configContainer = rawData.configurations;
const configsArray = configContainer?.configurations || [];
const activeConfig = configsArray[0];

if (!activeConfig) {
    console.error('No configuration found');
    process.exit(1);
}

const blocks = activeConfig.blocks || [];
console.log('--- Inspection Results ---');
console.log('Config ID:', activeConfig.id);
console.log('Blocks Found:', blocks.length);

// 1) List design variables
const variables: string[] = [];
blocks.forEach((b: any, bi: number) => {
  if (b.variables) {
    Object.keys(b.variables).forEach(k => {
      if (b.variables[k]?.isVariable) variables.push(`Block ${bi} (${b.blockType}): ${k}`);
    });
  }
});
console.log('Design Variables:', variables);

// 2) Validate blocks
const validationIssues = validateBlocksConfiguration(activeConfig);
console.log('Schema Validation:', validationIssues.length === 0 ? 'Passed' : 'Failed');
if (validationIssues.length > 0) {
    console.log('Validation Issues Count:', validationIssues.length);
}

// 3) Expand blocks
const result = expandBlocksToOpticalSystemRows(blocks);
const expandedRows = result.rows;
console.log('Expanded Rows Count:', expandedRows.length);

// 4) Check thickness change on expansion
const gapBlocksBefore = blocks.filter((b: any) => b.blockType === 'Gap' || b.blockType === 'AirGap')
                             .map((b: any) => ({ blockId: b.blockId, thickness: b.parameters?.thickness, isVariable: b.variables?.thickness?.isVariable }));

// Run expansion on the ORIGINAL array to see if it mutates
expandBlocksToOpticalSystemRows(blocks);

let mutationDetected = false;
gapBlocksBefore.filter(b => !b.isVariable).forEach((saved) => {
    const currentBlock = blocks.find((b: any) => b.blockId === saved.blockId);
    if (currentBlock && currentBlock.parameters?.thickness !== saved.thickness) {
        mutationDetected = true;
    }
});
console.log('Non-V Gap thickness changed merely by expansion:', mutationDetected);

// 5) Detect mismatch
const rootOpticalSystem = rawData.opticalSystem || [];
const osGapCount = rootOpticalSystem.length > 0 ? (rootOpticalSystem.length - 1) : 0;
const blockGapCount = gapBlocksBefore.length;
console.log('Block Gap Count:', blockGapCount);
console.log('Root opticalSystem Gap Count:', osGapCount);

if (blockGapCount !== osGapCount && osGapCount > 0) {
    console.log('Mismatch detected: block count (' + blockGapCount + ') vs opticalSystem gaps (' + osGapCount + ')');
} else {
    console.log('No mismatch detected or opticalSystem missing');
}

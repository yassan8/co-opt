import fs from 'node:fs';
import { validateBlocksConfiguration, expandBlocksIntoConfiguration } from './data/block-schema.ts';

const files = [
  '/Users/masanori/Downloads/20260421_Paraxial_3枚.json',
  '/Users/masanori/Downloads/JPA 1999072704-000000.json'
];

for (const file of files) {
  try {
    console.log(`--- File: ${file} ---`);
    if (!fs.existsSync(file)) {
        console.error("File does not exist");
        continue;
    }
    const rawContent = fs.readFileSync(file, 'utf8');
    const raw = JSON.parse(rawContent);
    const activeId = raw?.configurations?.activeConfigId;
    const cfg = raw?.configurations?.configurations?.find((item: any) => String(item?.id) === String(activeId)) || raw?.configurations?.configurations?.[0];

    if (!cfg) {
      console.error('No configuration found');
      continue;
    }

    const validation = validateBlocksConfiguration(cfg);
    if (validation && validation.length > 0) {
      console.log(`Validation issues detected: ${validation.length}`);
      console.log(JSON.stringify(validation, null, 2));
    } else {
      console.log('Validation: Passed');
    }

    const expanded = expandBlocksIntoConfiguration(cfg);
    const rows = expanded?.expandedOpticalSystem;
    console.log(`Expanded array: ${Array.isArray(rows)}, Row count: ${Array.isArray(rows) ? rows.length : 'N/A'}`);
  } catch (err: any) {
    console.error(`Error processing file: ${err.message}`);
  }
}

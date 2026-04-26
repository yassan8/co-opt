import fs from 'fs';
import { validateZoomLawDefinitions } from './data/block-schema.ts';

async function main() {
  const data = JSON.parse(fs.readFileSync('./defaults/default-load.json', 'utf-8'));
  const newText = `B=0:0,1:43.36\nconst zCseed=zC0\nC=camComp(B, phiB, phiC, zObj, zImg, zB0, zC0, zCseed)`;

  let targetBlock: any = null;
  for (const obj of data) {
    if (obj.blocks && Array.isArray(obj.blocks)) {
      targetBlock = obj.blocks.find((b: any) => b.type === 'ObjectSurface');
      if (targetBlock) break;
    }
  }

  if (targetBlock) {
    targetBlock.parameters.zoomGroupProfiles = newText;
    const errors = validateZoomLawDefinitions(newText);
    console.log(JSON.stringify(errors, null, 2));
  } else {
    console.log('ObjectSurface block not found');
  }
}

main();

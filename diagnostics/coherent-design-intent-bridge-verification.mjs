import {
  createPatentFig2AssemblyDesign,
  evaluateCoherentAssembly,
} from '../analysis/coherent-assembly.ts';
import {
  deriveDesignIntentPhysicalComponents,
  replaceDesignIntentSequenceComponents,
} from '../analysis/coherent-design-intent-bridge.ts';

const checks = [];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
  checks.push(message);
};
const close = (actual, expected, tolerance, message) => check(Math.abs(actual - expected) <= tolerance, `${message} (${actual} vs ${expected})`);

const lensBlocks = [
  { blockId: 'object', blockType: 'ObjectSurface', parameters: { objectDistance: 0 } },
  {
    blockId: 'lens-a', blockType: 'Lens', role: 'Beam expander L1',
    parameters: { frontRadius: 28, backRadius: -28, centerThickness: 4, material: 'N-BK7' },
    aperture: { front: 9, back: 9 },
  },
  { blockId: 'gap-a', blockType: 'AirGap', parameters: { thickness: 21 } },
  {
    blockId: 'lens-b', blockType: 'Lens', role: 'Beam expander L2',
    parameters: { frontRadius: 45, backRadius: -45, centerThickness: 5, material: 'N-BK7' },
    aperture: { front: 14, back: 14 },
  },
  { blockId: 'image', blockType: 'ImageSurface', parameters: { semidia: 14 } },
];

const sequence = {
  id: 'bridge-verification',
  label: 'Bridge verification',
  pathId: 'common',
  blocks: lensBlocks,
  rootTransform: {
    positionMm: { x: 100, y: 20, z: 30 },
    rotationDeg: { x: 0, y: 90, z: 0 },
  },
};

const derived = await deriveDesignIntentPhysicalComponents(sequence);
check(derived.components.length === 2, 'two Lens blocks expand into two physical lens solids');
check(derived.components.every((component) => component.metadata?.source === 'design-intent'), 'generated solids retain Design Intent provenance');
check(derived.components.every((component) => component.dimensionConfidence === 'Estimated'), 'aperture-based outside dimensions remain visibly estimated');
close(derived.components[0].dimensions.apertureDiameterMm, 18, 1e-9, 'first lens aperture diameter is preserved');
close(derived.components[1].dimensions.apertureDiameterMm, 28, 1e-9, 'second lens aperture diameter is preserved');
close(derived.components[0].dimensions.centerThicknessMm, 4, 1e-9, 'first lens thickness is preserved');
close(derived.components[1].dimensions.centerThicknessMm, 5, 1e-9, 'second lens thickness is preserved');
check(derived.components[1].autoTransform.positionMm.x > derived.components[0].autoTransform.positionMm.x, 'root Y rotation maps local optical Z progression into world X');
close(derived.components[0].autoTransform.positionMm.y, 20, 1e-9, 'root world Y translation is preserved');

const preset = createPatentFig2AssemblyDesign();
const assembled = replaceDesignIntentSequenceComponents(preset, sequence.id, derived.components);
const evaluation = evaluateCoherentAssembly(assembled);
check(evaluation.components.length === preset.components.length + 2, 'generated lens solids enter assembly inventory and volume evaluation');
check((evaluation.opticalVolumeMm3 ?? 0) > 0, 'assembly optical volume remains evaluable after expansion');

const unrotated = await deriveDesignIntentPhysicalComponents({
  ...sequence,
  rootTransform: { ...sequence.rootTransform, rotationDeg: { x: 0, y: 0, z: 0 } },
});
const volume = (items) => evaluateCoherentAssembly(replaceDesignIntentSequenceComponents(createPatentFig2AssemblyDesign(), sequence.id, items)).opticalVolumeMm3;
close(volume(derived.components), volume(unrotated.components), 1e-6, 'component rotation does not change optical solid volume');
check(
  Math.abs(derived.components[1].autoTransform.positionMm.x - unrotated.components[1].autoTransform.positionMm.x) > 1,
  'root rotation changes placement while preserving the solid',
);

const missingAperture = await deriveDesignIntentPhysicalComponents({
  ...sequence,
  id: 'missing-aperture',
  blocks: lensBlocks.map((block) => block.blockId === 'lens-a' ? { ...block, aperture: {} } : block),
});
check(missingAperture.components.some((component) => component.dimensionConfidence === 'Missing'), 'missing Design Intent aperture is reported as Missing');

console.log(JSON.stringify({
  ok: true,
  checks: checks.length,
  expandedSurfaces: derived.expandedSurfaceCount,
  generatedComponents: derived.components.length,
  generatedWorldPositionsMm: derived.components.map((component) => component.autoTransform.positionMm),
}, null, 2));

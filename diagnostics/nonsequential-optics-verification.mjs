import assert from 'node:assert/strict';
import { createPatentFig2AssemblyDesign } from '../analysis/coherent-assembly.ts';
import { createCombGratingAreaDesign, createPatentFig14DualCombDesign } from '../analysis/coherent-presets.ts';
import { buildNonSequentialTraceRequest, runNonSequentialTrace } from '../analysis/nonsequential-trace.ts';

const closeRelative = (actual, expected, tolerance, label) => {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance * scale, `${label}: ${actual} != ${expected}`);
};

const fig2 = createPatentFig2AssemblyDesign();
assert.equal(fig2.schemaVersion, '1.0');
assert.equal(fig2.grating.grooveDensityLinesPerMm, 600);
assert.equal(fig2.sources?.[0].kind, 'supercontinuum');
assert.equal(fig2.detectors?.[0].kind, 'area');
const fig2Request = buildNonSequentialTraceRequest(fig2, 'preview');
assert.ok(fig2Request.surfaces.some((surface) => surface.interaction.kind === 'beam-splitter'));
assert.ok(fig2Request.surfaces.some((surface) => surface.interaction.kind === 'grating'));
assert.ok(fig2Request.surfaces.some((surface) => surface.interaction.kind === 'detector'));
const fig2Result = await runNonSequentialTrace(fig2, 'preview');
assert.ok(fig2Result.segments.length > 0, 'Figure 2 produces physical ray segments');
assert.ok(fig2Result.detectors[0].hitCount > 0, 'Figure 2 reaches the area detector');
const fig2Accounted = fig2Result.energy.detectedRayPowerW + fig2Result.energy.escapedPowerW + fig2Result.energy.absorbedPowerW + fig2Result.energy.truncatedPowerW;
closeRelative(fig2Accounted, fig2Result.energy.emittedPowerW, 1e-9, 'Figure 2 energy accounting');
const scatteredTarget = structuredClone(fig2);
scatteredTarget.target.interaction = 'lambertian';
scatteredTarget.target.scatterSamples = 8;
const scatteredResult = await runNonSequentialTrace(scatteredTarget, 'preview');
const scatteredAccounted = scatteredResult.energy.detectedRayPowerW + scatteredResult.energy.escapedPowerW + scatteredResult.energy.absorbedPowerW + scatteredResult.energy.truncatedPowerW;
closeRelative(scatteredAccounted, scatteredResult.energy.emittedPowerW, 1e-9, 'Lambertian target energy accounting');
assert.ok(scatteredResult.generatedRayCount > fig2Result.generatedRayCount, 'Lambertian target generates sampled scatter rays');
assert.ok(scatteredResult.segments.some((segment) => segment.history.includes('target-100') && segment.history.includes(':S')), 'scatter history is visible to Render and ghost accounting');

const comb = createCombGratingAreaDesign();
comb.detector.pixelCountX = 512;
comb.detector.pixelCountY = 128;
comb.detectors[0] = comb.detector;
const combResult = await runNonSequentialTrace(comb, 'preview');
assert.equal(combResult.spectrumLines.length, comb.traceSettings.previewSpectralSamples);
for (const line of combResult.spectrumLines) {
  const source = comb.sources[0];
  closeRelative(line.frequencyHz, source.ceoFrequencyHz + line.lineIndex * source.repetitionRateHz, 1e-14, 'comb frequency f_ceo + n f_rep');
}
assert.ok(combResult.segments.some((segment) => segment.history.includes(':m1')), 'm=1 diffracted rays are generated');
assert.ok(combResult.detectors[0].hitCount > 0, 'dispersed comb reaches physical area detector');

const dual = createPatentFig14DualCombDesign();
dual.detector.sampleCount = 512;
dual.detectors[0] = dual.detector;
const dualResult = await runNonSequentialTrace(dual, 'preview');
assert.equal(dual.sources.length, 2);
assert.equal(dualResult.detectors[0].kind, 'time');
assert.ok(dualResult.detectors[0].timeSignalW.length === 512, 'time detector samples are generated');
assert.ok(dualResult.detectors[0].rfBeats.length > 0, 'dual-comb RF beats are generated');
const sortedBeats = [...dualResult.detectors[0].rfBeats].sort((left, right) => left.frequencyHz - right.frequencyHz);
assert.ok(sortedBeats.every((beat) => beat.frequencyHz >= 0 && Number.isFinite(beat.frequencyHz)));

console.log(JSON.stringify({
  fig2: { rays: fig2Result.generatedRayCount, hits: fig2Result.detectors[0].hitCount, detectedW: fig2Result.energy.detectedRayPowerW },
  scatter: { rays: scatteredResult.generatedRayCount, hits: scatteredResult.detectors[0].hitCount, detectedW: scatteredResult.energy.detectedRayPowerW },
  comb: { modes: combResult.spectrumLines.length, hits: combResult.detectors[0].hitCount },
  dualComb: { rfBeats: dualResult.detectors[0].rfBeats.length, samples: dualResult.detectors[0].timeSignalW.length },
}, null, 2));

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  page: await readFile(new URL('../src/app/ImageSimulationPage.tsx', import.meta.url), 'utf8'),
  model: await readFile(new URL('../src/app/image-simulation-model.ts', import.meta.url), 'utf8'),
  distortionPage: await readFile(new URL('../src/app/DistortionAnalysisPage.tsx', import.meta.url), 'utf8'),
  multi: await readFile(new URL('../src/app/MultiFieldPsfPage.tsx', import.meta.url), 'utf8'),
  app: await readFile(new URL('../src/app/App.tsx', import.meta.url), 'utf8'),
  toolbar: await readFile(new URL('../src/ui/components/MainToolbar.tsx', import.meta.url), 'utf8'),
  handlers: await readFile(new URL('../ui/toolbar-handlers.ts', import.meta.url), 'utf8'),
  styles: await readFile(new URL('../styles.css', import.meta.url), 'utf8'),
};

assert.match(files.page, /data-analysis-kind="image-simulation"/);
assert.match(files.page, /runNativeGridDistortion/);
assert.match(files.page, /computeFieldPsf/);
assert.match(files.page, /scaleFieldExtentForDistortionGrid/);
assert.match(files.page, /Math\.tan/);
assert.match(files.page, /colorMode:\s*'true'/);
assert.match(files.page, /buildWavelengthEntries/);
assert.match(files.page, /distortionEntries = simulationMode === 'psf'/);
assert.match(files.page, /PSFPlotter\.wavelengthToLinearRGB/);
assert.match(files.page, /result\.spectralComponents/);
assert.match(files.page, /detectConjugateType\(opticalRows\)/);
assert.match(files.page, /<small>Conjugate<\/small>/);
assert.doesNotMatch(files.page, /rotateMultiFieldPsfGridCartesian/, 'image simulation must not bilinearly rotate before rebinning');
assert.match(
  files.page,
  /resamplePsfToImageKernel\([\s\S]*?component\.psfData[\s\S]*?kernelSize,[\s\S]*?rotation,/,
  'PSF rotation and image-pixel rebinning must happen in one conservative stage',
);
assert.match(files.multi, /spectralComponents: results\.map/);
assert.match(files.page, /opdMode:\s*'pistonTiltRemoved'/);
assert.match(files.page, /Full: Distortion \+ PSF/);
assert.match(files.page, /Distortion only/);
assert.match(files.page, /PSF only/);
assert.match(files.page, /Wipe slider/);
assert.match(files.page, /Side by side/);
assert.match(files.page, /Difference/);
assert.match(files.page, /Co-opt Field Chart/);
assert.match(files.page, /USAF 1951 Field Array/);
assert.match(files.page, /MIL-STD-150A element proportions/);
assert.match(files.page, /Grid & Point Sources/);
assert.match(files.page, /Upload image/);
assert.match(files.page, /generateImageSimulationTargetSvg/);
assert.match(files.page, /rasterizeImageSimulationTargetSvg/);
assert.match(files.page, /Save SVG/);
assert.match(files.page, /downloadSimulatedPng/);
assert.match(files.page, /Save PNG/);
assert.match(files.page, /canvas\.toBlob/);
assert.match(files.page, /'image\/png'/);
assert.match(files.page, /co-opt-simulated-/);
assert.match(files.page, /disabled=\{busy \|\| !simulatedImage\}/);
assert.match(files.page, /value=\{4096\}/);
assert.match(files.page, /SVG vector/);
assert.doesNotMatch(files.page, />Stop</);
assert.match(files.model, /convolveImageSpatiallyVarying/);
assert.match(files.model, /warpImageWithDistortion/);
assert.match(files.model, /srgbToLinear/);
assert.match(files.model, /resamplePsfToImageKernel/);
assert.match(files.model, /exact overlap area/);
assert.match(files.model, /Math\.floor\(columns \/ 2\)/);
assert.match(files.model, /combineImageSimulationSpectralLayers/);
assert.match(files.model, /calculateMaxLateralChromaticDisplacementUm/);
assert.match(files.model, /viewBox="0 0 4096 4096"/);
assert.match(files.model, /native SVG vectors/);
assert.match(files.model, /getUsaf1951ElementGeometry/);
assert.match(files.model, /data-usaf-scale="normalized"/);
assert.match(files.app, /<ImageSimulationPage/);
assert.match(files.toolbar, /value="image-simulation"/);
assert.match(files.handlers, /'image-simulation': \{ width: 1280, height: 900, title: 'Image Simulation' \}/);
assert.match(files.styles, /\.image-simulation-wipe__slider/);
assert.match(files.styles, /\.image-simulation-side-by-side/);
const wipeMarkup = files.page.match(/<div className="image-simulation-wipe"[\s\S]*?<span className="image-simulation-wipe__divider"/)?.[0] || '';
assert.ok(wipeMarkup, 'wipe comparison markup must exist');
assert.match(
  wipeMarkup,
  /<CanvasImage image=\{simulated \|\| original\}[\s\S]*?image-simulation-wipe__result[\s\S]*?<CanvasImage image=\{original\}/,
  'wipe must show simulated underneath and reveal original from the left',
);
assert.doesNotMatch(wipeMarkup, /image-simulation-wipe__label/, 'wipe image labels must be removed');
assert.doesNotMatch(files.page, /className="image-simulation-summary"/, 'source summary chips must be removed');
assert.match(files.page, /image-simulation-progress__track/);
assert.match(files.page, /image-simulation-progress__status/);
assert.match(files.page, /\{busy \? Math\.round\(progress\) \+ '% · ' \+ progressText : progressText\}/);
assert.doesNotMatch(files.page, /<ProgressBar value=\{progress\}/, 'progress must not render a second percent/status row');
assert.doesNotMatch(files.styles, /\.image-simulation-summary/);
assert.doesNotMatch(files.styles, /\.image-simulation-wipe__label/);

assert.match(files.page, /calculateImageSpaceDiffractionParams/);
assert.match(files.page, /value="field-fit"/);
assert.match(files.page, /value="sensor-width"/);
assert.match(files.page, /value="pixel-pitch"/);
assert.match(files.page, /Sensor width \(mm\)/);
assert.match(files.page, /Sensor height \(mm\)/);
assert.match(files.page, /<option value="sensor-width">Sensor size<\/option>/);
assert.match(files.page, /sensorWidthMm: requestedSensorWidthMm/);
assert.match(files.page, /sensorHeightMm: requestedSensorHeightMm/);
assert.match(files.distortionPage, /id="grid-sensor-width-input"/);
assert.match(files.distortionPage, /id="grid-sensor-height-input"/);
assert.match(files.distortionPage, /sensorWidthMm,/);
assert.match(files.distortionPage, /sensorHeightMm,/);
assert.match(files.page, /Pixel pitch \(µm\)/);
assert.match(files.page, /resolveImageSimulationRasterExtent/);
assert.match(files.page, /warpImageWithDistortion\(layerImage, distortionLayer\.map, rasterExtent\)/);
assert.match(files.page, /fieldToRasterX/);
assert.match(files.page, /fieldToRasterY/);
assert.match(files.page, /<small>Image scale<\/small>/);
assert.match(files.page, /<small>EFL · F\/# · Airy diameter<\/small>/);
assert.match(files.page, /<small>Nyquist · cutoff<\/small>/);
assert.match(files.page, /<small>Chart frequency<\/small>/);
assert.match(files.page, /diffractionMtfAtChart/);
assert.match(files.model, /getImageSimulationTargetNominalMaxFrequencyLpmm/);
assert.match(files.model, /resolveImageSimulationRasterExtent/);
assert.match(files.page, /<strong>Scale guide<\/strong>/);
assert.match(files.page, /Full-band Nyquist: ≤/);
assert.match(files.page, /requiredHorizontalSamples/);
assert.match(files.page, /Use the real detector pitch only when Raster output matches the sensor\/crop pixel count/);
assert.match(files.styles, /\.image-simulation-scale-guide/);
assert.match(files.page, /unreachedDistortionPoints/);
assert.match(files.page, /Distortion extrapolated/);
assert.match(files.page, /distortion nodes extrapolated/);
assert.match(files.page, /Distortion fields/);
assert.match(files.styles, /\.image-simulation-reachability-warning/);

console.log(JSON.stringify({
  ok: true,
  modes: ['full', 'distortion-only', 'psf-only'],
  comparisons: ['wipe', 'side-by-side', 'difference'],
  sources: ['generated-field-chart', 'usaf-array', 'grid-points', 'upload'],
  realGridDistortion: true,
  realMultiFieldPsf: true,
  wavelengthSpecificDistortion: true,
  monochromaticFieldPsfs: true,
  conjugates: ['infinite', 'finite'],
  psfRebinning: 'single-stage conservative area overlap',
  cieLinearRgbSynthesis: true,
  centeredPsfKernel: 'Remove P/T',
  stopButton: false,
  vectorSource: 'native SVG',
  maxRasterOutput: 4096,
  svgDownload: true,
  simulatedPngDownload: true,
  simulatedPngResolution: 'native simulation output',
  wipeLeft: 'original',
  wipeRight: 'simulated',
  wipeLabels: false,
  sourceSummaryChips: false,
  completionStatus: 'inline Done without 100%',
  imageScaleModes: ['field-fit', 'sensor-width', 'pixel-pitch'],
  dynamicScaleGuide: true,
  independentSensorSize: 'width × height',
  unreachedVisibility: 'marker + warning + count',
}, null, 2));

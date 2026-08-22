import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  page: await readFile(new URL('../src/app/ImageSimulationPage.tsx', import.meta.url), 'utf8'),
  model: await readFile(new URL('../src/app/image-simulation-model.ts', import.meta.url), 'utf8'),
  calibratedTarget: await readFile(new URL('../src/app/calibrated-camera-resolution-target.ts', import.meta.url), 'utf8'),
  opticalShowcase: await readFile(new URL('../src/app/optical-showcase-target.ts', import.meta.url), 'utf8'),
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
assert.match(files.page, /<option value="optical-showcase">USAF 1951 Radial Grid<\/option>/);
assert.match(files.page, /useState<ImageSimulationTargetKind \| 'upload'>\('optical-showcase'\)/);
assert.match(files.page, /Calibrated Camera Resolution Chart/);
assert.match(files.page, /USAF 1951 Field Array/);
assert.match(files.page, /central Group −2\/−1 pair is surrounded by eight radial and sixteen orthogonal Group 0\/1 pairs/);
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
assert.match(files.page, /Frequencies follow 2\^\(group \+ \(element−1\)\/6\)/);
assert.match(files.page, /every tri-bar occupies a 5w × 5w square, with equal bar and space widths/);
assert.match(files.page, /Each pair follows the classic imaginary-square layout/);
assert.match(files.page, /Four binary radial charts sample the field corners/);
assert.match(files.page, /an sRGB color bar and an eleven-step grayscale bar span the upper and lower edges/);
assert.match(files.page, /both group headings are 3\.75× the coarser Element 1 bar width/);
assert.match(files.page, /calibrated chart remains available for eSFR/);
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
assert.match(files.model, /generateCalibratedCameraResolutionTargetSvg/);
assert.match(files.calibratedTarget, /widthMm:\s*240/);
assert.match(files.calibratedTarget, /heightMm:\s*240/);
assert.match(files.calibratedTarget, /edgeAnglesDeg:\s*Object\.freeze\(\[-7, -5, 5, 7\]\)/);
assert.match(files.calibratedTarget, /Math\.pow\(2, group \+ \(element - 1\) \/ 6\)/);
assert.match(files.calibratedTarget, /1 \/ \(2 \* frequency\)/);
assert.match(files.calibratedTarget, /data-coordinate-unit="mm"/);
assert.match(files.calibratedTarget, /data-cycles-per-revolution/);
assert.match(files.model, /generateOpticalShowcaseTargetSvg/);
assert.match(files.opticalShowcase, /data-scene="optical-showcase"/);
assert.match(files.opticalShowcase, /getUsafElementGeometry/);
assert.match(files.opticalShowcase, /createUsafElement/);
assert.match(files.opticalShowcase, /createUsafPairPlate/);
assert.match(files.opticalShowcase, /data-layout="classic-spiral-pair"/);
assert.match(files.opticalShowcase, /data-imaginary-square-left-mm/);
assert.match(files.opticalShowcase, /data-imaginary-square-right-mm/);
assert.match(files.opticalShowcase, /createCornerRadialCharts/);
assert.match(files.opticalShowcase, /createColorAndGrayscaleBars/);
assert.match(files.opticalShowcase, /data-diagnostic="opaque-reference-square"/);
assert.match(files.opticalShowcase, /data-diagnostic="field-grid"/);
assert.match(files.opticalShowcase, /data-diagnostic="radial-grid"/);
assert.match(files.opticalShowcase, /data-usaf-frequency-formula/);
assert.match(files.opticalShowcase, /groupNumberToPairReferenceBarRatio:\s*3\.75/);
assert.match(files.opticalShowcase, /primaryElementNumberToPairReferenceBarRatio:\s*2\.7/);
assert.match(files.opticalShowcase, /secondaryElementNumberToPairReferenceBarRatio:\s*1\.65/);
assert.match(files.page, /co-opt-usaf-1951-radial-grid\.svg/);
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
  sources: ['optical-showcase', 'calibrated-camera-chart', 'usaf-array', 'grid-points', 'upload'],
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

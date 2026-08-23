import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

const stubPlugin = {
  name: 'multi-field-psf-ui-stubs',
  setup(esbuild) {
    esbuild.onResolve({ filter: /PsfAnalysisPage$/ }, () => ({ path: 'psf-analysis-page', namespace: 'multi-field-psf-stub' }));
    esbuild.onResolve({ filter: /AnalysisGridSamplingField$/ }, () => ({ path: 'analysis-grid-sampling', namespace: 'multi-field-psf-stub' }));
    esbuild.onResolve({ filter: /evaluation\/psf\/psf-plot\.ts$/ }, () => ({ path: 'psf-plotter', namespace: 'multi-field-psf-stub' }));
    esbuild.onLoad({ filter: /.*/, namespace: 'multi-field-psf-stub' }, ({ path }) => {
      if (path === 'analysis-grid-sampling') {
        return {
          loader: 'tsx',
          resolveDir: root,
          contents: `
            import React from 'react';
            export const ANALYSIS_PUPIL_SAMPLING_OPTIONS = [{ value: 32, label: '32 × 32' }];
            export function AnalysisGridSamplingField({ value }) {
              return <label><span>Pupil Sampling</span><select value={value} readOnly><option value={32}>32 × 32</option></select></label>;
            }
          `,
        };
      }
      if (path === 'psf-plotter') {
        return { loader: 'js', contents: 'export class PSFPlotter {}' };
      }
      return {
        loader: 'tsx',
        resolveDir: root,
        contents: `
          import React from 'react';
          export const buildWavelengthEntries = () => [{ wavelength: 0.5876, weight: 1 }];
          export const buildWavelengthOptions = () => [{ value: 'all', label: 'All' }];
          export const createCancelToken = () => ({ aborted: false, abort() { this.aborted = true; } });
          export const derivePsfScale = () => ({ pixelSizeUm: 1, fNumberWorking: 4 });
          export const getBestHost = () => ({});
          export const getPrimaryWavelength = () => 0.58756;
          export const getRows = () => [];
          export function ProgressBar({ value, text }) { return <div aria-label={text}>{value}</div>; }
          export const raceWithCancel = (promise) => promise;
          export const sampleBilinear = () => 0;
          export const throwIfCancelled = () => {};
          export const waitForFunction = async (name) => ({ fn: (payload) => globalThis.__multiFieldPsfRunner(name, payload) });
        `,
      };
    });
  },
};

const entry = `
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MultiFieldPsfPage, computeFieldPsf } from './src/app/MultiFieldPsfPage.tsx';

  const html = renderToStaticMarkup(<MultiFieldPsfPage />);
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const fieldGrid = html.match(/<span>Field Grid<\\/span><select[^>]*>([\\s\\S]*?)<\\/select>/u)?.[1] || '';
  const presetCount = (fieldGrid.match(/<option /gu) || []).length - 1;
  expect(html.includes('data-analysis-kind="multi-field-psf"'), 'Multi-Field PSF root was not rendered');
  expect(presetCount >= 18, 'Field Grid does not expose enough presets');
  expect(fieldGrid.includes('31×31'), '31×31 Field Grid option is missing');
  expect(fieldGrid.includes('Custom'), 'Custom Field Grid option is missing');
  expect(html.includes('<strong>5×5</strong> grid'), 'Default grid is not 5×5');
  expect(html.includes('25 field points'), 'Default rectangular grid does not expose all 25 points');
  expect(html.includes('True color'), 'True Color option is missing');
  expect(html.includes('False color (UV/IR)'), 'False Color UV/IR option is missing');
  expect(/<option value="raw" selected="">Preserve P\\/T \\(Raw\\)<\\/option>/u.test(html), 'Preserve P/T (Raw) is not the initial Wavefront option');
  expect(!html.includes('<span>View</span>'), 'View selector must be removed from the Mosaic-only window');
  expect(!html.includes('>Tiles</option>'), 'Tiles view option must be removed');
  expect(!html.includes('<span>Tile size</span>'), 'Tile size option must be removed');
  expect(html.includes('Global image: +Y ↑ · +X →'), 'Global image orientation indicator is missing');
  expect(!html.includes('type="checkbox" checked=""'), 'Log scale must be off initially');
  expect(html.includes('Every PSF is placed at its global field position.'), 'Mosaic-only guidance is missing');
  expect(html.includes('Choose a Field Grid and press Show.'), 'Empty-state guidance is missing');
  expect(html.includes('>Show</button>'), 'Show action is missing');
  expect(!html.includes('>Stop</button>'), 'Unexpected Stop action is present');
  const calls = [];
  const pupil = Array.from({ length: 32 }, () => Array(32).fill(0));
  const targetX = Array.from({ length: 32 }, () => Array(32).fill(0));
  const targetY = Array.from({ length: 32 }, (_, y) => Array(32).fill((y - 15.5) / 2));
  globalThis.__multiFieldPsfRunner = (name, payload) => {
    calls.push({ name, payload });
    if (name === 'runDesktopNativeOpdMapForPopup') {
      return { rawOpdGrid: pupil, displayOpdGrid: pupil, targetHitXGridMm: targetX, targetHitYGridMm: targetY };
    }
    if (name === 'runDesktopNativeSpotRaytraceForPopup') {
      return { series: [{ points: Array.from({ length: 65 }, (_, index) => ({ xUm: 0, yUm: (index - 32) * 312.5 })) }] };
    }
    if (name === 'runDesktopNativePsfMapForPopup') {
      return {
        psfData: [[0, 1, 0], [0, 2, 0], [0, 1, 0]],
        pixelSizeUm: 2.5,
        method: 'hybrid-geometric',
        metrics: { strehlRatio: 0.5, fwhm: { x: 1, y: 2 } },
        geometricSampling: { mode: 'line', rayCount: 65, effectiveSpacingUm: 312.5, axis: { x: 0, y: 1 } },
      };
    }
    throw new Error('Unexpected runner: ' + name);
  };
  globalThis.__multiFieldHybridTestPromise = computeFieldPsf({
    host: {},
    opticalRows: [{ type: 'Surface' }],
    sourceRows: [{ wavelength: 0.5876, primary: true }],
    fieldObjectRow: { id: 1, position: 'Angle', angle: { x: 0, y: 0 } },
    wavelengthValue: 'primary',
    samplingSize: 32,
    zeroPad: 'none',
    colorMode: 'pseudo',
    opdMode: 'raw',
    logScale: false,
    token: { aborted: false, abort() {} },
    onProgress() {},
  }).then((computed) => {
    const spotCall = calls.find((call) => call.name === 'runDesktopNativeSpotRaytraceForPopup');
    const psfCall = calls.find((call) => call.name === 'runDesktopNativePsfMapForPopup');
    expect(Boolean(spotCall), 'Multi-Field PSF did not trace detector rays');
    expect(spotCall.payload.pattern === 'grid', 'Multi-Field PSF detector rays must use the pupil grid pattern');
    expect(psfCall.payload.propagationMode === 'auto', 'Multi-Field PSF did not enable hybrid propagation');
    expect(psfCall.payload.rayHitsUm.length === 65, 'Multi-Field PSF did not forward detector hits');
    expect(psfCall.payload.targetHitYGridMm === targetY, 'Multi-Field PSF did not forward OPD target intersections');
    expect(psfCall.payload.hybridOutputSize === 512, 'Multi-Field PSF hybrid output size changed');
    expect(Math.abs(psfCall.payload.diffractionFwhmXUm - 1.028 * 0.5876 * 4) < 1e-12, 'Multi-Field PSF diffraction width is wrong');
    expect(computed.method === 'hybrid-geometric', 'Multi-Field PSF dropped the hybrid method');
    expect(computed.pixelSizeUm === 2.5, 'Multi-Field PSF ignored the hybrid detector pixel scale');
    expect(computed.geometricSampling?.effectiveSpacingUm === 312.5, 'Multi-Field PSF dropped measured detector spacing');
  });
  console.log(JSON.stringify({ ok: true, presetCount, defaultGrid: '5×5', defaultFieldPoints: 25, trueColor: true, initialWavefront: 'Preserve P/T (Raw)', mosaicOnly: true, initialLogScale: false, stopButton: false }, null, 2));
`;

const result = await build({
  stdin: { contents: entry, loader: 'tsx', resolveDir: root, sourcefile: 'multi-field-psf-ui-entry.tsx' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  jsx: 'automatic',
  write: false,
  minify: true,
  plugins: [stubPlugin],
});

const bundled = result.outputFiles?.[0]?.text;
if (!bundled) throw new Error('UI diagnostic bundle was not generated.');
const temporaryBundle = join(tmpdir(), `coopt-multi-field-psf-ui-${randomUUID()}.cjs`);
try {
  await writeFile(temporaryBundle, bundled, 'utf8');
  await import(pathToFileURL(temporaryBundle).href);
  await globalThis.__multiFieldHybridTestPromise;
} catch (error) {
  console.error(`Multi-Field PSF UI diagnostic failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await unlink(temporaryBundle).catch(() => {});
}

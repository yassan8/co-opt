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
          export const buildWavelengthEntries = () => [];
          export const buildWavelengthOptions = () => [{ value: 'all', label: 'All' }];
          export const createCancelToken = () => ({ aborted: false, abort() { this.aborted = true; } });
          export const derivePsfScale = () => ({ pixelSizeUm: 1 });
          export const getBestHost = () => ({});
          export const getPrimaryWavelength = () => 0.58756;
          export const getRows = () => [];
          export function ProgressBar({ value, text }) { return <div aria-label={text}>{value}</div>; }
          export const raceWithCancel = (promise) => promise;
          export const sampleBilinear = () => 0;
          export const throwIfCancelled = () => {};
          export const waitForFunction = async () => ({ fn: () => ({}) });
        `,
      };
    });
  },
};

const entry = `
  import { renderToStaticMarkup } from 'react-dom/server';
  import { MultiFieldPsfPage } from './src/app/MultiFieldPsfPage.tsx';

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
} catch (error) {
  console.error(`Multi-Field PSF UI diagnostic failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await unlink(temporaryBundle).catch(() => {});
}

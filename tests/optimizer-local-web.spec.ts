import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'Examples/20260802_optimize_qcon_surf.json'), 'utf8'),
);
const requestedIterations = Math.max(1, Math.floor(Number(process.env.COOPT_E2E_MAX_ITERATIONS) || 2));
const requestedSpotWorkers = String(process.env.COOPT_E2E_SPOT_WORKERS || '').trim().toLowerCase();
const requestedAutoRender = String(process.env.COOPT_E2E_AUTO_RENDER || '').trim().toLowerCase() === 'on';
const requestedRepeatRun = String(process.env.COOPT_E2E_REPEAT_RUN || '').trim().toLowerCase() === 'on';

type StopVariableState = {
  rows: Array<Record<string, unknown>>;
  blocks: Array<{ blockId: string; variables: Record<string, unknown> }>;
};

async function readStopVariableState(page: import('@playwright/test').Page): Promise<StopVariableState> {
  return page.evaluate(() => {
    const host = window as any;
    const rows = typeof host.getOpticalSystemRows === 'function'
      ? host.getOpticalSystemRows(host.tableOpticalSystem)
      : [];
    const configSet = typeof host.loadSystemConfigurationsFromTableConfig === 'function'
      ? host.loadSystemConfigurationsFromTableConfig()
      : host.loadSystemConfigurations?.();
    const active = configSet?.configurations?.find((config: any) => String(config?.id) === String(configSet?.activeConfigId));
    return {
      rows: (Array.isArray(rows) ? rows : [])
        .filter((row: any) => row?.['object type'] === 'Stop' || row?.object === 'Stop')
        .map((row: any) => Object.fromEntries(
          Object.entries(row).filter(([key]) => key.startsWith('optimize')),
        )),
      blocks: (Array.isArray(active?.blocks) ? active.blocks : [])
        .filter((block: any) => block?.blockType === 'Stop')
        .map((block: any) => ({
          blockId: String(block?.blockId ?? ''),
          variables: block?.variables && typeof block.variables === 'object' ? block.variables : {},
        })),
    };
  });
}

function expectStopHasNoVariables(state: StopVariableState): void {
  expect(state.rows.length).toBeGreaterThan(0);
  for (const row of state.rows) {
    expect(Object.values(row).some((value) => String(value ?? '').trim().toUpperCase() === 'V')).toBe(false);
  }
  expect(state.blocks.length).toBeGreaterThan(0);
  for (const block of state.blocks) expect(block.variables).toEqual({});
}
test('Parameter All ON never marks the Stop block as a design variable', async ({ page }) => {
  await page.goto('?stop-variable-e2e=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as any).__loadAllDataObjectIntoApp === 'function');
  await page.evaluate(async (data) => {
    const contaminated = JSON.parse(JSON.stringify(data));
    for (const config of contaminated?.configurations?.configurations || []) {
      for (const block of config?.blocks || []) {
        if (block?.blockType !== 'Stop') continue;
        block.variables = {
          semiDiameter: { value: block?.parameters?.semiDiameter, optimize: { mode: 'V', scope: 'perConfig' } },
          zoomGroup: { value: '', optimize: { mode: 'V', scope: 'perConfig' } },
        };
      }
    }
    await (window as any).__loadAllDataObjectIntoApp(contaminated, {
      filename: '20260802_optimize_qcon_surf.json',
    });
  }, fixture);
  expectStopHasNoVariables(await readStopVariableState(page));

  await page.getByRole('button', { name: 'Open navigator' }).first().click();
  await page.locator('.win-tree-leaf', { hasText: 'Design Intent' }).click();
  await page.locator('#design-intent-param-all-on-btn').evaluate((element) => (element as HTMLButtonElement).click());
  await page.waitForTimeout(150);
  await page.evaluate(async () => {
    await (window as any).loadActiveConfigurationToTables?.({ applyToUI: true });
  });
  expectStopHasNoVariables(await readStopVariableState(page));
});

test('Qcon optimization completes in local Edge without losing its run inputs', async ({ page }, testInfo) => {
  test.setTimeout(Math.max(90_000, requestedIterations * 45_000 + (requestedRepeatRun ? 60_000 : 0)));
  const pageErrors: string[] = [];
  const browserConsoleMessages: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    const value = message.text();
    if (/Spot WorkerPool|WASM worker/i.test(value)) browserConsoleMessages.push(message.type() + ': ' + value);
  });
  await page.route(/googleads|doubleclick|googletagmanager|google-analytics|adsbygoogle/, (route) => route.abort());

  await page.goto('?optimizer-e2e=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof (window as any).__loadAllDataObjectIntoApp === 'function');
  await page.evaluate(async (data) => {
    await (window as any).__loadAllDataObjectIntoApp(data, {
      filename: '20260802_optimize_qcon_surf.json',
    });
  }, fixture);
  expectStopHasNoVariables(await readStopVariableState(page));

  await page.locator('button.app-shell__menuSummary', { hasText: 'Run' }).evaluate((element) => (element as HTMLButtonElement).click());
  await page.locator('button.app-shell__menuAction', { hasText: 'Optimize' }).evaluate((element) => (element as HTMLButtonElement).click());

  const iframeElement = await page.locator('iframe[title^="Optimize"]').elementHandle();
  const optimizer = await iframeElement?.contentFrame();
  if (!optimizer) throw new Error('Optimize Progress iframe did not open');

  await optimizer.locator('button').first().waitFor({ state: 'visible' });
  await optimizer.evaluate((spotWorkers) => {
    const optimizerWindow = window as any;
    if (!optimizerWindow.__optimizerWorkerTracker && typeof optimizerWindow.Worker === 'function') {
      const NativeWorker = optimizerWindow.Worker;
      const tracker = { created: 0, terminated: 0, live: new Set<Worker>(), urls: [] as string[] };
      const TrackingWorker = function (...args: any[]) {
        const worker = new NativeWorker(...args);
        tracker.created += 1;
        tracker.live.add(worker);
        tracker.urls.push(String(args[0] || ''));
        const nativeTerminate = worker.terminate.bind(worker);
        worker.terminate = () => {
          if (tracker.live.delete(worker)) tracker.terminated += 1;
          nativeTerminate();
        };
        return worker;
      };
      TrackingWorker.prototype = NativeWorker.prototype;
      optimizerWindow.Worker = TrackingWorker;
      optimizerWindow.__optimizerWorkerTracker = tracker;
    }
    (window as any).__COOPT_SPOT_PROFILE = true;
    (window as any).__cooptSpotRequirementDiag = null;
    (window as any).__cooptImageHeightWarmStartDiag = null;
    if (spotWorkers === 'on') (window as any).__COOPT_SPOT_WORKERS = true;
    else if (spotWorkers === 'off') (window as any).__COOPT_SPOT_WORKERS = false;
    else delete (window as any).__COOPT_SPOT_WORKERS;
  }, requestedSpotWorkers);

  const body = optimizer.locator('body');
  await expect(body).toContainText(/Variables\s*6/);
  await expect(body).toContainText(/Requirements\s*3/);

  const numericInputs = optimizer.locator('input[type="number"]');
  await numericInputs.nth(0).fill(String(requestedIterations));
  await expect(numericInputs.nth(1)).toHaveValue('1');
  await expect(numericInputs.nth(1)).toBeDisabled();
  const checkboxes = optimizer.locator('input[type="checkbox"]');
  for (let index = 0; index < await checkboxes.count(); index++) {
    if (requestedAutoRender) await checkboxes.nth(index).check();
    else if (await checkboxes.nth(index).isChecked()) await checkboxes.nth(index).uncheck();
  }

  const runButton = optimizer.getByRole('button', { name: 'Run', exact: true });
  await optimizer.evaluate(() => {
    const samples: Array<{ status: string; percent: number }> = [];
    const captureProgress = () => {
      const status = document.querySelector('.optimize-progress-status')?.textContent?.trim() || '';
      const percentText = document.querySelector('.optimize-progress-percent')?.textContent || '';
      const percent = Number.parseFloat(percentText);
      if (Number.isFinite(percent)) samples.push({ status, percent });
    };
    const progressRoot = document.querySelector('.optimize-progress-header');
    const observer = new MutationObserver(captureProgress);
    if (progressRoot) observer.observe(progressRoot, { attributes: true, childList: true, characterData: true, subtree: true });
    (window as any).__optimizerProgressSamples = samples;
    (window as any).__optimizerProgressObserver = observer;
    captureProgress();
  });
  const startedAt = Date.now();
  await runButton.click();
  await expect(runButton).toBeDisabled({ timeout: 5_000 });
  await expect(runButton).toBeEnabled({ timeout: Math.max(90_000, requestedIterations * 45_000) });
  const progressSamples = await optimizer.evaluate(() => {
    (window as any).__optimizerProgressObserver?.disconnect?.();
    return (window as any).__optimizerProgressSamples || [];
  }) as Array<{ status: string; percent: number }>;
  expect(progressSamples.filter((sample) => sample.percent >= 100 && !/^(done|finished|complete)$/i.test(sample.status))).toEqual([]);
  await expect(optimizer.locator('.optimize-progress-status')).toHaveText(/done/i);
  await expect(optimizer.locator('.optimize-progress-percent')).toHaveText('100%');
  await optimizer.waitForTimeout(750);
  const postRunRuntime = await page.evaluate(() => ({
    optimizerIsRunning: (window as any).__cooptOptimizerIsRunning === true,
    opticalRowsOverrideCount: Array.isArray((window as any).__cooptOpticalSystemRowsOverride)
      ? (window as any).__cooptOpticalSystemRowsOverride.length
      : 0,
    drawCrossInFlight: (window as any).__cooptDrawCrossInFlight === true,
    drawCrossPending: !!(window as any).__cooptDrawCrossLastData,
  }));
  const postRunWorkers = await optimizer.evaluate(() => {
    const tracker = (window as any).__optimizerWorkerTracker;
    return tracker
      ? { created: tracker.created, terminated: tracker.terminated, live: tracker.live.size, urls: tracker.urls }
      : { created: 0, terminated: 0, live: 0, urls: [] };
  });

  expectStopHasNoVariables(await readStopVariableState(page));

  const measurement = await optimizer.evaluate(() => {
    const profile = (window as any).OptimizationMVP?.getLastProfile?.() || null;
    const scoreMatch = document.body.innerText.match(/Score\s*([0-9.+-]+)/);
    return {
      profile,
      spot: (window as any).__cooptSpotRequirementDiag || null,
      warmStart: (window as any).__cooptImageHeightWarmStartDiag || null,
      score: scoreMatch ? Number(scoreMatch[1]) : null,
    };
  });
  const consoleScores = await page.evaluate(() => document.body.innerText
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+([0-9.+-]+)/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({ iteration: Number(match[1]), score: Number(match[2]) }))
    .filter((entry) => Number.isFinite(entry.iteration) && Number.isFinite(entry.score)));
  const costLine = await page.evaluate(() => document.body.innerText
    .split('\n')
    .find((line) => line.includes('[Cost]')) || '');
  const wallMs = Date.now() - startedAt;
  console.log('[optimizer-e2e] workers=' + (requestedSpotWorkers || 'auto') + ' wall=' + wallMs + 'ms internal=' + Math.round(measurement.profile?.totalMs || 0) + 'ms prep=' + Math.round(measurement.spot?.preparedGenerationMs || 0) + 'ms score=' + measurement.score + ' ' + costLine + ' postRun=' + JSON.stringify(postRunRuntime) + ' workersAfter=' + JSON.stringify(postRunWorkers) + ' workerMessages=' + JSON.stringify(browserConsoleMessages));

  await testInfo.attach('optimizer-profile.json', {
    body: JSON.stringify({ wallMs, pageErrors, browserConsoleMessages, consoleScores, costLine, postRunRuntime, postRunWorkers, ...measurement }, null, 2),
    contentType: 'application/json',
  });

  expect(pageErrors).toEqual([]);
  expect(postRunRuntime).toEqual({
    optimizerIsRunning: false,
    opticalRowsOverrideCount: 0,
    drawCrossInFlight: false,
    drawCrossPending: false,
  });
  expect(postRunWorkers.live).toBe(0);
  expect(postRunWorkers.terminated).toBe(postRunWorkers.created);
  expect(measurement.profile?.result?.ok).toBe(true);
  expect(measurement.profile?.result?.aborted).toBe(false);
  expect(measurement.profile?.counts?.kktIterCount).toBeGreaterThan(0);
  expect(measurement.profile?.counts?.kktIterCount).toBeLessThanOrEqual(requestedIterations);
  expect(measurement.spot?.calls).toBeGreaterThanOrEqual(42);
  expect(measurement.warmStart?.['continuation-cache']).toBeGreaterThan(0);
  expect(consoleScores.length).toBeGreaterThanOrEqual(requestedIterations + 1);
  for (let index = 1; index < consoleScores.length; index++) {
    expect(consoleScores[index].score).toBeLessThan(consoleScores[index - 1].score);
  }
  expect(consoleScores[0].score).toBeGreaterThan(1_000);
  expect(consoleScores[0].score).toBeLessThan(1_200);
  expect(measurement.score).toBeLessThan(requestedIterations >= 5 ? 100 : requestedIterations >= 2 ? 400 : 850);
  expect(measurement.spot?.preparedGenerationMs).toBeLessThan(1_000);
  expect(measurement.profile?.totalMs).toBeLessThan(requestedIterations * 16_000);
  expect(wallMs).toBeLessThan(requestedIterations * 18_000 + 15_000);

  if (requestedRepeatRun) {
    await numericInputs.nth(0).fill('1');
    const repeatStartedAt = Date.now();
    await runButton.click();
    await expect(runButton).toBeDisabled({ timeout: 5_000 });
    await expect(runButton).toBeEnabled({ timeout: 90_000 });
    await expect(optimizer.locator('.optimize-progress-status')).toHaveText(/done/i);
    await optimizer.waitForTimeout(750);
    const repeatRuntime = await page.evaluate(() => ({
      optimizerIsRunning: (window as any).__cooptOptimizerIsRunning === true,
      opticalRowsOverrideCount: Array.isArray((window as any).__cooptOpticalSystemRowsOverride)
        ? (window as any).__cooptOpticalSystemRowsOverride.length
        : 0,
      drawCrossInFlight: (window as any).__cooptDrawCrossInFlight === true,
      drawCrossPending: !!(window as any).__cooptDrawCrossLastData,
    }));
    const repeatWorkers = await optimizer.evaluate(() => {
      const tracker = (window as any).__optimizerWorkerTracker;
      return tracker
        ? { created: tracker.created, terminated: tracker.terminated, live: tracker.live.size }
        : { created: 0, terminated: 0, live: 0 };
    });
    console.log('[optimizer-e2e-repeat] wall=' + (Date.now() - repeatStartedAt) + 'ms postRun=' + JSON.stringify(repeatRuntime) + ' workersAfter=' + JSON.stringify(repeatWorkers));
    expect(repeatRuntime).toEqual({
      optimizerIsRunning: false,
      opticalRowsOverrideCount: 0,
      drawCrossInFlight: false,
      drawCrossPending: false,
    });
    expect(repeatWorkers.live).toBe(0);
    expect(repeatWorkers.terminated).toBe(repeatWorkers.created);
  }
});

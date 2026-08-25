import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readOptionalExampleFixtureOrExit } from './optional-example-fixture.mjs';

const fixture = await readOptionalExampleFixtureOrExit('JPA_2026126953_Figure2_fiber_NA0p1.json');

function preparedSystem(detectorSamples, target) {
  const system = structuredClone(fixture.configurations);
  const config = system.configurations[0];
  system.activeConfigId = config.id;
  const source = config.blocks.find((block) => block.blockId === 'BroadbandSource-11');
  source.parameters.detectorSpatialSamples = detectorSamples;
  source.parameters.spectralSamples = 1;
  config.source = [config.source?.[0] ?? { wavelength: 0.65, isPrimary: true }];
  Object.assign(config.blocks.find((block) => block.blockId === 'Target-100').parameters, target);
  return system;
}

async function runAndRead(page) {
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.locator('.coherent-signal-status strong').filter({ hasText: /^Done/ }).waitFor({ timeout: 120_000 });
  const metric = async (label) => {
    const row = page.locator('.coherent-signal-metrics span').filter({ hasText: label }).first();
    return (await row.locator('strong').innerText()).trim();
  };
  return {
    launched: Number((await metric('Rays launched')).replaceAll(',', '')),
    hits: Number((await metric('Detector hits')).replaceAll(',', '')),
    physicalOpdMm: Number((await metric('Physical OPD')).replace('mm', '').trim()),
  };
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const flat = preparedSystem(81, { profile: 'flat', amplitudeUm: 0, offsetUm: 0 });
  await page.addInitScript((system) => {
    if (!localStorage.getItem('systemConfigurations')) localStorage.setItem('systemConfigurations', JSON.stringify(system));
  }, flat);
  const url = 'http://127.0.0.1:5176/co-opt/?coopt_analysis_window=1&coopt_analysis=coherent-interferometer';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.locator('select').filter({ has: page.locator('option[value="32"]') }).selectOption('32').catch(() => undefined);
  const before = await runAndRead(page);

  const step = preparedSystem(169, { profile: 'step', amplitudeUm: 100, stepPositionMm: -100, offsetUm: 0 });
  await page.evaluate((system) => localStorage.setItem('systemConfigurations', JSON.stringify(system)), step);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('select').filter({ has: page.locator('option[value="32"]') }).selectOption('32').catch(() => undefined);
  const after = await runAndRead(page);

  console.log(JSON.stringify({ before, after }, null, 2));
  assert.equal(before.launched, 162, 'two routes launch 81 rays per sampled wavelength');
  assert.equal(after.launched, 338, 'two routes launch 169 rays per sampled wavelength');
  assert.notEqual(after.hits, before.hits, 'Detector hit count responds to the Source Detector sampling');
  assert.ok(Math.abs(after.physicalOpdMm - before.physicalOpdMm) > 0.1, 'Target Step changes the displayed physical OPD');
  await context.close();
} finally {
  await browser.close();
}

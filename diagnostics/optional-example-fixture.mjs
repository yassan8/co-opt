import { readFile } from 'node:fs/promises';

export async function readOptionalExampleFixture(fileName) {
  const candidates = [
    new URL(`../private/Examples/${fileName}`, import.meta.url),
    new URL(`../Examples/${fileName}`, import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

export async function readOptionalExampleFixtureOrExit(fileName) {
  const fixture = await readOptionalExampleFixture(fileName);
  if (fixture) return fixture;
  console.log(JSON.stringify({
    skipped: true,
    reason: `Optional private regression fixture is unavailable: ${fileName}`,
  }, null, 2));
  process.exit(0);
}

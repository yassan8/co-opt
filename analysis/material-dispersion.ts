import { calculateGlassRefractiveIndex, getAllGlassDatabases } from '../data/glass.ts';

export interface SubstrateDispersionSpec {
  substrateMaterial?: unknown;
  substrateIndexNd?: unknown;
  substrateAbbeNumber?: unknown;
}

const positive = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

let catalogByName: Map<string, any> | undefined;
function catalogGlass(name: string): any {
  if (!catalogByName) {
    catalogByName = new Map();
    for (const database of getAllGlassDatabases()) {
      for (const glass of database) {
        const key = String(glass.name).trim().toUpperCase();
        if (!catalogByName.has(key)) catalogByName.set(key, glass);
      }
    }
  }
  return catalogByName.get(name.toUpperCase());
}

/** Two-term Cauchy approximation anchored at nd and (nF - nC) = (nd - 1)/Vd. */
export function cauchyIndexFromNdVd(nd: number, vd: number | undefined, wavelengthNm: number): number {
  if (!vd || !Number.isFinite(vd) || vd <= 0 || nd === 1) return nd;
  const lambdaUm = wavelengthNm / 1000;
  const b = ((nd - 1) / vd) / (1 / 0.4861327 ** 2 - 1 / 0.6562725 ** 2);
  return nd + b * (1 / lambdaUm ** 2 - 1 / 0.5875618 ** 2);
}

/**
 * Unspecified legacy substrates use N-BK7. Explicit nd without a glass name
 * remains a user-defined medium; never infer a catalog glass from a nearby nd.
 */
export function resolveSubstrateDispersion(
  parameters: SubstrateDispersionSpec,
  fallback: SubstrateDispersionSpec = {},
): Required<SubstrateDispersionSpec> {
  const hasLocalIndex = positive(parameters.substrateIndexNd) !== undefined;
  const hasLocalMaterial = parameters.substrateMaterial !== undefined && parameters.substrateMaterial !== null;
  const material = String(parameters.substrateMaterial
    ?? (hasLocalIndex ? '' : fallback.substrateMaterial ?? 'N-BK7')).trim();
  return {
    substrateMaterial: material,
    substrateIndexNd: positive(parameters.substrateIndexNd) ?? positive(fallback.substrateIndexNd) ?? 1.5168,
    substrateAbbeNumber: parameters.substrateAbbeNumber
      ?? (hasLocalIndex || hasLocalMaterial ? 0 : fallback.substrateAbbeNumber ?? 64.17),
  };
}

/** Catalog dispersion takes precedence; blank/numeric material uses nd/Vd. */
export function substrateRefractiveIndex(
  parameters: SubstrateDispersionSpec,
  wavelengthNm: number,
  fallback: SubstrateDispersionSpec = {},
): number {
  if (!(Number.isFinite(wavelengthNm) && wavelengthNm > 0)) throw new Error('Material dispersion requires a positive wavelength in nm.');
  const spec = resolveSubstrateDispersion(parameters, fallback);
  const name = String(spec.substrateMaterial);
  if (['AIR', 'VACUUM'].includes(name.toUpperCase())) return 1;
  const numericMaterial = name === '' ? undefined : positive(name);
  const nd = numericMaterial ?? Number(spec.substrateIndexNd);
  let index: number;
  if (name && numericMaterial === undefined) {
    const glass = catalogGlass(name);
    if (!glass) throw new Error(`Unknown substrate glass "${name}". Choose a catalog glass or leave Substrate glass blank and enter nd / Abbe number.`);
    index = glass.sellmeier || glass.schott || glass.dispersion || glass.sumita
      ? calculateGlassRefractiveIndex(glass, wavelengthNm / 1000)
      : cauchyIndexFromNdVd(glass.nd, positive(glass.vd), wavelengthNm);
  } else {
    index = cauchyIndexFromNdVd(nd, positive(spec.substrateAbbeNumber), wavelengthNm);
  }
  if (!(Number.isFinite(index) && index > 0)) throw new Error(`Invalid refractive index for substrate "${name || 'nd / Abbe'}" at ${wavelengthNm} nm.`);
  return index;
}

/** Spectral phase at the source exit: phi0 + tau*dOmega + GDD*dOmega^2/2. */
export function sourceSpectralPhaseRad(source: {
  centerWavelengthNm?: number;
  initialPhaseRad?: number;
  relativePhaseRad?: number;
  relativeDelayFs?: number;
  groupDelayDispersionFs2?: number;
}, frequencyHz: number): number {
  const finite = (value: unknown): number => Number.isFinite(Number(value)) ? Number(value) : 0;
  const centerFrequencyHz = 299_792_458 / ((positive(source.centerWavelengthNm) ?? 587.5618) * 1e-9);
  const deltaOmega = 2 * Math.PI * (frequencyHz - centerFrequencyHz);
  return finite(source.initialPhaseRad) + finite(source.relativePhaseRad)
    + finite(source.relativeDelayFs) * 1e-15 * deltaOmega
    + 0.5 * finite(source.groupDelayDispersionFs2) * 1e-30 * deltaOmega ** 2;
}

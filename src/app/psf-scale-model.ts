export function calculatePsfImagePixelSizeUm(
  wavelengthUm: number,
  fNumberWorking: number,
  samplingSize: number,
  fftSize: number,
): number {
  const wavelength = Number(wavelengthUm);
  const fNumber = Number(fNumberWorking);
  const sampling = Number(samplingSize);
  const fft = Number(fftSize);
  if (!(wavelength > 0 && fNumber > 0 && sampling > 0 && fft > 0)) return Number.NaN;
  return wavelength * fNumber * sampling / fft;
}

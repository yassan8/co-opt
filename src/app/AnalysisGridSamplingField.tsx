type AnalysisGridSamplingFieldProps = {
  value: string | number;
  options: readonly (string | number)[];
  onValueChange: (value: string) => void;
  label?: string;
  title?: string;
};

export const ANALYSIS_PUPIL_SAMPLING_OPTIONS = [
  32,
  64,
  128,
  256,
  512,
  1024,
  2048,
  4096,
] as const;

export function AnalysisGridSamplingField({
  value,
  options,
  onValueChange,
  label = 'Pupil sampling',
  title,
}: AnalysisGridSamplingFieldProps) {
  return (
    <label className="analysis-window-field">
      <span>{label}</span>
      <select
        value={String(value)}
        onChange={(event) => onValueChange(event.target.value)}
        title={title}
      >
        {options.map((option) => {
          const optionValue = String(option);
          return (
            <option key={optionValue} value={optionValue}>
              {optionValue} × {optionValue}
            </option>
          );
        })}
      </select>
    </label>
  );
}

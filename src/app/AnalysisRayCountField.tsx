type AnalysisRayCountFieldProps = {
  value: string | number;
  onValueChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
  title?: string;
};

export function AnalysisRayCountField({
  value,
  onValueChange,
  min = 1,
  max,
  step = 1,
  id,
  title,
}: AnalysisRayCountFieldProps) {
  return (
    <label className="analysis-window-field" htmlFor={id}>
      <span>Rays</span>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        title={title}
        onChange={(event) => onValueChange(event.target.value)}
      />
    </label>
  );
}

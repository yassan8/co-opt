import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createDefaultToleranceStudy,
  getToleranceVariableValue,
  listToleranceCandidates,
  normalizeToleranceStudy,
  resultSummary,
  runMonteCarloTolerance,
  runSensitivityAnalysis,
  setToleranceVariableValue,
  type MonteCarloToleranceResult,
  type SensitivityAnalysisResult,
  type ToleranceCompensatorSpec,
  type ToleranceParameterSpec,
  type ToleranceProgress,
  type ToleranceStudy,
} from '../../analysis/tolerance-study.ts';
import {
  evaluateRequirementsForToleranceCandidate,
  evaluateRequirementsForToleranceCandidates,
} from '../../analysis/tolerance-requirements-adapter.ts';
import { loadSystemConfigurations, saveSystemConfigurations, type SystemConfiguration } from '../../data/table-configuration.ts';
import type { ToleranceVariableDescriptor } from '../../optimization/design-variables.ts';
import { getBestHost } from './PsfAnalysisPage.tsx';
import './ToleranceAnalysisPage.css';

type AnalysisResult = SensitivityAnalysisResult | MonteCarloToleranceResult;
export type EngineeringAnalysisMode = 'sensitivity' | 'tolerance';

const clone = <T,>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const finite = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const percent = (value: number): string => `${(100 * value).toFixed(value >= 0.995 || value <= 0.005 ? 1 : 1)}%`;
const formatNumber = (value: unknown, digits = 5): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric !== 0 && (Math.abs(numeric) < 1e-4 || Math.abs(numeric) >= 1e5)) return numeric.toExponential(3);
  return numeric.toFixed(digits).replace(/\.?0+$/, '');
};

function readSystemConfig(host: any): SystemConfiguration {
  try {
    const value = host?.ConfigurationManager?.loadSystemConfigurations?.();
    if (value?.configurations) return clone(value);
  } catch (_) {}
  return clone(loadSystemConfigurations());
}

function saveSystemConfig(host: any, value: SystemConfiguration): void {
  const snapshot = clone(value);
  try {
    if (host?.ConfigurationManager?.saveSystemConfigurations) host.ConfigurationManager.saveSystemConfigurations(snapshot);
    else saveSystemConfigurations(snapshot);
  } catch (_) {
    saveSystemConfigurations(snapshot);
  }
  try { host?.dispatchEvent?.(new CustomEvent('coopt:system-configurations-updated', { detail: { source: 'tolerance-analysis' } })); } catch (_) {}
}

function suggestedTolerance(variable: ToleranceVariableDescriptor): number {
  const magnitude = Math.abs(variable.value);
  if (variable.category === 'radius') return Math.max(0.001, magnitude * 0.001);
  if (variable.category === 'thickness') return 0.02;
  if (variable.category === 'material') return /abbe/i.test(variable.key) ? 0.5 : 0.0005;
  if (variable.category === 'asphere') return Math.max(1e-10, magnitude * 0.01);
  if (variable.category === 'decenter' || variable.category === 'position') return 0.01;
  if (variable.category === 'tilt') return 0.05;
  if (variable.category === 'aperture') return 0.02;
  return Math.max(0.001, magnitude * 0.001);
}

function parameterFromCandidate(variable: ToleranceVariableDescriptor): ToleranceParameterSpec {
  const tolerance = suggestedTolerance(variable);
  return {
    id: `tol-param-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    enabled: true,
    configId: String(variable.configId ?? ''),
    variableRef: variable.id,
    label: variable.label,
    unit: variable.unit,
    minusTolerance: tolerance,
    plusTolerance: tolerance,
    distribution: 'normal',
    sigmaMode: 'three-sigma',
  };
}

function ProgressBar({ progress }: { progress: ToleranceProgress | null }) {
  if (!progress) return null;
  const display = progress.phase === 'done' ? 100 : Math.min(99, progress.percent);
  return <div className="tolerance-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(display)}>
    <div><span>{Math.round(display)}%</span><span>{progress.message}</span></div>
    <div className="tolerance-progress__track"><div style={{ width: `${display}%` }} /></div>
  </div>;
}

function MetricCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return <div className="tolerance-metric"><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>;
}

export default function ToleranceAnalysisPage({ mode }: { mode: EngineeringAnalysisMode }) {
  const host = useMemo(() => getBestHost(), []);
  const [systemConfig, setSystemConfig] = useState<SystemConfiguration>(() => readSystemConfig(host));
  const initialStudies = useMemo(() => {
    const stored = Array.isArray(systemConfig.toleranceStudies) ? systemConfig.toleranceStudies.map(normalizeToleranceStudy) : [];
    return stored.length > 0 ? stored : [createDefaultToleranceStudy()];
  }, []);
  const [studies, setStudies] = useState<ToleranceStudy[]>(initialStudies);
  const [selectedStudyId, setSelectedStudyId] = useState(initialStudies[0].id);
  const [candidateId, setCandidateId] = useState('');
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [progress, setProgress] = useState<ToleranceProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const runMethod = mode === 'sensitivity' ? 'sensitivity' : 'monte-carlo';
  const analysisTitle = mode === 'sensitivity' ? 'Sensitivity Analysis' : 'Tolerance Analysis';

  const study = studies.find((entry) => entry.id === selectedStudyId) ?? studies[0];
  const requirements = useMemo(() => (Array.isArray(systemConfig.systemRequirements) ? systemConfig.systemRequirements : []).filter((row: any) => row && row.rowType !== 'memo' && row.enabled !== false && row.operand), [systemConfig]);
  const referencedConfigIds = useMemo(() => {
    if (study?.configScope === 'all') return (systemConfig.configurations || []).map((entry: any) => String(entry.id));
    if (study?.configScope === 'active') return [String(systemConfig.activeConfigId)];
    const ids = new Set(requirements.map((row: any) => String(row.configId || systemConfig.activeConfigId)));
    return Array.from(ids);
  }, [study?.configScope, systemConfig, requirements]);
  const candidates = useMemo(() => listToleranceCandidates(systemConfig, referencedConfigIds), [systemConfig, referencedConfigIds.join('|')]);
  const candidateById = useMemo(() => new Map(candidates.map((entry) => [`${entry.configId}|${entry.id}`, entry])), [candidates]);
  const parameterKeys = useMemo(() => new Set((study?.parameters || []).map((entry) => `${entry.configId}|${entry.variableRef}`)), [study?.parameters]);
  const availableCandidates = candidates.filter((entry) => !parameterKeys.has(`${entry.configId}|${entry.id}`));

  useEffect(() => {
    document.title = analysisTitle;
    return () => abortRef.current?.abort('Window closed');
  }, [analysisTitle]);

  useEffect(() => {
    if (candidateId && availableCandidates.some((entry) => `${entry.configId}|${entry.id}` === candidateId)) return;
    setCandidateId(availableCandidates[0] ? `${availableCandidates[0].configId}|${availableCandidates[0].id}` : '');
  }, [availableCandidates.map((entry) => `${entry.configId}|${entry.id}`).join('|')]);

  const persistStudies = (nextStudies: ToleranceStudy[], nextSelectedId = selectedStudyId) => {
    const normalized = nextStudies.map(normalizeToleranceStudy);
    const nextSystem = clone(systemConfig);
    nextSystem.toleranceStudies = normalized;
    setStudies(normalized);
    setSelectedStudyId(nextSelectedId);
    setSystemConfig(nextSystem);
    saveSystemConfig(host, nextSystem);
  };

  const patchStudy = (patch: Partial<ToleranceStudy>) => {
    if (!study) return;
    setResult(null);
    setProgress(null);
    persistStudies(studies.map((entry) => entry.id === study.id ? normalizeToleranceStudy({ ...entry, ...patch }) : entry));
  };

  const createStudy = () => {
    const created = createDefaultToleranceStudy(`Engineering Study ${studies.length + 1}`);
    persistStudies([...studies, created], created.id);
    setResult(null);
    setProgress(null);
  };

  const deleteStudy = () => {
    if (!study || studies.length <= 1) return;
    if (!host?.confirm?.(`Delete \"${study.name}\"?`)) return;
    const next = studies.filter((entry) => entry.id !== study.id);
    persistStudies(next, next[0].id);
    setResult(null);
    setProgress(null);
  };

  const patchParameter = (id: string, patch: Partial<ToleranceParameterSpec>) => {
    if (!study) return;
    patchStudy({ parameters: study.parameters.map((entry) => entry.id === id ? { ...entry, ...patch } : entry) });
  };

  const addSelectedParameter = () => {
    if (!study || !candidateId) return;
    const candidate = candidateById.get(candidateId);
    if (!candidate) return;
    patchStudy({ parameters: [...study.parameters, parameterFromCandidate(candidate)] });
  };

  const addLensTolerances = () => {
    if (!study) return;
    const allowed = new Set(['radius', 'thickness', 'material', 'asphere', 'decenter', 'tilt']);
    const additions = availableCandidates.filter((entry) => allowed.has(entry.category)).map(parameterFromCandidate);
    patchStudy({ parameters: [...study.parameters, ...additions] });
  };

  const addCompensator = () => {
    if (!study) return;
    const preferred = candidates.find((entry) => entry.suggestedCompensator)
      ?? candidates.find((entry) => entry.blockType === 'AreaDetector' && /positionz/i.test(entry.key))
      ?? candidates.find((entry) => entry.category === 'thickness');
    if (!preferred) return;
    if (study.compensators.some((entry) => entry.configId === String(preferred.configId ?? '') && entry.variableRef === preferred.id)) return;
    const nominal = preferred.value;
    const compensator: ToleranceCompensatorSpec = {
      id: `tol-comp-${Date.now().toString(36)}`,
      enabled: true,
      configId: String(preferred.configId ?? ''),
      variableRef: preferred.id,
      label: preferred.label,
      minimum: nominal - 1,
      maximum: nominal + 1,
      samples: 9,
    };
    patchStudy({ compensators: [...study.compensators, compensator] });
  };

  const selectedRequirements = useMemo(() => {
    const selected = new Set(study?.requirementIds || []);
    return requirements.filter((row: any) => selected.size === 0 || selected.has(String(row.id)));
  }, [requirements, study?.requirementIds]);

  const run = async () => {
    if (!study || busy) return;
    setError('');
    setBusy(true);
    setProgress({ phase: 'nominal', completed: 0, total: 1, percent: 0, message: 'Preparing study' });
    const controller = new AbortController();
    abortRef.current = controller;
    const snapshot = readSystemConfig(host);
    try {
      const runStudy = mode === 'sensitivity'
        ? { ...study, runSettings: { ...study.runSettings, compensate: false } }
        : study;
      const context = {
        systemConfig: snapshot,
        study: runStudy,
        requirementRows: selectedRequirements,
        evaluateCandidate: (candidate: any, rows: any[]) => evaluateRequirementsForToleranceCandidate(host, candidate, rows, controller.signal),
        evaluateCandidates: (candidates: any[], rows: any[]) => evaluateRequirementsForToleranceCandidates(host, candidates, rows, controller.signal),
        candidateBatchSize: 24,
        onProgress: setProgress,
        signal: controller.signal,
      };
      const next = runMethod === 'sensitivity' ? await runSensitivityAnalysis(context) : await runMonteCarloTolerance(context);
      setResult(next);
      const nextStudies = studies.map((entry) => entry.id === study.id ? { ...entry, lastResultSummary: resultSummary(next) } : entry);
      persistStudies(nextStudies);
    } catch (nextError) {
      if ((nextError as any)?.name !== 'AbortError') setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };

  const createWorstConfig = () => {
    if (!study || result?.method !== 'monte-carlo' || !result.worstTrial) return;
    const nextSystem = clone(readSystemConfig(host));
    const activeId = String(nextSystem.activeConfigId);
    const source = nextSystem.configurations.find((entry: any) => String(entry.id) === activeId);
    if (!source) return;
    const workingSystem: any = { ...nextSystem, configurations: [clone(source)] };
    for (const parameter of study.parameters) {
      if (String(parameter.configId) !== activeId) continue;
      const delta = result.worstTrial.appliedDeltas[parameter.id];
      if (!Number.isFinite(delta)) continue;
      const nominal = getToleranceVariableValue(workingSystem, activeId, parameter.variableRef);
      if (nominal !== null) setToleranceVariableValue(workingSystem, activeId, parameter.variableRef, nominal + delta);
    }
    const existingNumeric = nextSystem.configurations.map((entry: any) => Number(entry.id)).filter(Number.isFinite);
    const newId: any = existingNumeric.length === nextSystem.configurations.length ? Math.max(0, ...existingNumeric) + 1 : `tol-${Date.now().toString(36)}`;
    const created = workingSystem.configurations[0];
    created.id = newId;
    created.name = `${source.name} · Worst trial ${result.worstTrial.index}`;
    created.metadata = { ...(created.metadata || {}), created: new Date().toISOString(), modified: new Date().toISOString(), toleranceSourceStudyId: study.id };
    nextSystem.configurations.push(created);
    nextSystem.activeConfigId = newId;
    saveSystemConfig(host, nextSystem);
    setSystemConfig(nextSystem);
  };

  if (!study) return <div className="analysis-window-error">Tolerance Study could not be created.</div>;

  const activeResult = result && result.method === runMethod ? result : null;
  return <div className="analysis-window-page tolerance-page" data-analysis-kind={mode === 'sensitivity' ? 'sensitivity-analysis' : 'tolerance-analysis'}>
    <div className="analysis-window-commandbar tolerance-commandbar">
      <label className="analysis-window-field"><span>Study</span><select value={study.id} onChange={(event) => setSelectedStudyId(event.target.value)}>{studies.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
      <button type="button" onClick={createStudy}>New</button>
      <button className="is-danger" type="button" disabled={studies.length <= 1 || busy} onClick={deleteStudy}>Delete</button>
      <label className="analysis-window-field"><span>Config</span><select value={study.configScope} onChange={(event) => patchStudy({ configScope: event.target.value as any })}><option value="requirements">Referenced by Requirements</option><option value="active">Active Config</option><option value="all">All Configs</option></select></label>
      {mode === 'tolerance' ? <label className="analysis-window-field"><span>Trials</span><select value={study.runSettings.trials} onChange={(event) => patchStudy({ runSettings: { ...study.runSettings, trials: Number(event.target.value) } })}><option value={100}>Draft · 100</option><option value={500}>Standard · 500</option><option value={2000}>Final · 2000</option></select></label> : null}
      <details className="analysis-window-options"><summary>Options</summary><div className="analysis-window-options__panel tolerance-options">
        <label className="analysis-window-field"><span>Study name</span><input value={study.name} onChange={(event) => patchStudy({ name: event.target.value })} /></label>
        {mode === 'tolerance' ? <label className="analysis-window-field"><span>Seed</span><input type="number" value={study.runSettings.seed} onChange={(event) => patchStudy({ runSettings: { ...study.runSettings, seed: Number(event.target.value) } })} /></label> : null}
        {mode === 'sensitivity' ? <label className="analysis-window-field"><span>Difference step</span><select value={study.runSettings.sensitivityStepFraction} onChange={(event) => patchStudy({ runSettings: { ...study.runSettings, sensitivityStepFraction: Number(event.target.value) } })}><option value={0.1}>10% of specified step</option><option value={0.25}>25% of specified step</option><option value={0.5}>50% of specified step</option><option value={1}>Full specified step</option></select></label> : null}
        {mode === 'tolerance' ? <label className="analysis-window-toggle"><input type="checkbox" checked={study.runSettings.compensate} onChange={(event) => patchStudy({ runSettings: { ...study.runSettings, compensate: event.target.checked } })} />Use compensators</label> : null}
        <div className="tolerance-requirements"><strong>Requirements</strong><span>{selectedRequirements.length} enabled</span>{requirements.map((row: any) => <label key={String(row.id)}><input type="checkbox" checked={study.requirementIds.length === 0 || study.requirementIds.includes(String(row.id))} onChange={(event) => {
          const currentlyAll = study.requirementIds.length === 0;
          const base = currentlyAll ? requirements.map((entry: any) => String(entry.id)) : [...study.requirementIds];
          const next = event.target.checked ? Array.from(new Set([...base, String(row.id)])) : base.filter((id) => id !== String(row.id));
          patchStudy({ requirementIds: next.length === requirements.length ? [] : next });
        }} />{row.operand} · Config {row.configId || systemConfig.activeConfigId}</label>)}</div>
      </div></details>
      <button className="analysis-window-primary-action" type="button" disabled={busy || study.parameters.length === 0 || selectedRequirements.length === 0} onClick={() => void run()}>{mode === 'sensitivity' ? 'Run Sensitivity' : 'Run Tolerance'}</button>
      {busy ? <button type="button" onClick={() => abortRef.current?.abort('Stopped')}>Stop</button> : null}
    </div>

    <ProgressBar progress={progress} />
    {error ? <div className="analysis-window-error">{error}</div> : null}

    <section className="tolerance-setup">
      <div className="tolerance-section-heading"><div><strong>{mode === 'sensitivity' ? 'Sensitivity parameters' : 'Tolerance parameters'}</strong><span>{mode === 'sensitivity' ? 'Specify the negative and positive perturbation used to measure each derivative.' : 'Manufacturing and alignment variation. Suggested values are estimates and should be replaced by supplier data.'}</span></div><div className="tolerance-add-controls"><select value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">Select parameter</option>{availableCandidates.map((entry) => <option key={`${entry.configId}|${entry.id}`} value={`${entry.configId}|${entry.id}`}>{entry.label} · Config {entry.configId}</option>)}</select><button type="button" onClick={addSelectedParameter} disabled={!candidateId}>Add</button><button type="button" onClick={addLensTolerances} disabled={availableCandidates.length === 0}>Add lens defaults</button></div></div>
      <div className="tolerance-table-wrap"><table className="tolerance-table"><thead><tr><th>On</th><th>Parameter</th><th>Nominal</th><th>{mode === 'sensitivity' ? '−Step' : '−Tol'}</th><th>{mode === 'sensitivity' ? '+Step' : '+Tol'}</th>{mode === 'tolerance' ? <th>Distribution</th> : null}<th /></tr></thead><tbody>
        {study.parameters.length === 0 ? <tr><td colSpan={mode === 'tolerance' ? 7 : 6} className="tolerance-empty">Add manufacturing or alignment parameters to begin.</td></tr> : null}
        {study.parameters.map((parameter) => {
          const candidate = candidateById.get(`${parameter.configId}|${parameter.variableRef}`);
          const nominal = getToleranceVariableValue(systemConfig, parameter.configId, parameter.variableRef);
          return <tr key={parameter.id}><td><input type="checkbox" checked={parameter.enabled} onChange={(event) => patchParameter(parameter.id, { enabled: event.target.checked })} /></td><td><strong>{parameter.label || candidate?.label || parameter.variableRef}</strong><small>Config {parameter.configId} · {parameter.unit || candidate?.unit || 'unitless'}</small></td><td>{formatNumber(nominal)}</td><td><input type="number" min={0} step="any" value={parameter.minusTolerance} onChange={(event) => patchParameter(parameter.id, { minusTolerance: Math.max(0, finite(event.target.value)) })} /></td><td><input type="number" min={0} step="any" value={parameter.plusTolerance} onChange={(event) => patchParameter(parameter.id, { plusTolerance: Math.max(0, finite(event.target.value)) })} /></td>{mode === 'tolerance' ? <td><select value={`${parameter.distribution}|${parameter.sigmaMode}`} onChange={(event) => { const [distribution, sigmaMode] = event.target.value.split('|'); patchParameter(parameter.id, { distribution: distribution as any, sigmaMode: sigmaMode as any }); }}><option value="normal|three-sigma">Normal · limits = 3σ</option><option value="normal|one-sigma">Normal · limits = 1σ</option><option value="uniform|full-width">Uniform · full limits</option></select></td> : null}<td><button className="is-danger" type="button" onClick={() => patchStudy({ parameters: study.parameters.filter((entry) => entry.id !== parameter.id) })}>Remove</button></td></tr>;
        })}
      </tbody></table></div>
      {mode === 'tolerance' ? <details className="tolerance-compensators"><summary><strong>Compensation</strong><span>{study.compensators.filter((entry) => entry.enabled).length || 'No'} active compensator</span></summary><div><button type="button" onClick={addCompensator}>Add auto-focus compensator</button>{study.compensators.map((compensator) => <div className="tolerance-compensator-row" key={compensator.id}><label><input type="checkbox" checked={compensator.enabled} onChange={(event) => patchStudy({ compensators: study.compensators.map((entry) => entry.id === compensator.id ? { ...entry, enabled: event.target.checked } : entry) })} />{compensator.label || compensator.variableRef}</label><label>Min<input type="number" step="any" value={compensator.minimum} onChange={(event) => patchStudy({ compensators: study.compensators.map((entry) => entry.id === compensator.id ? { ...entry, minimum: finite(event.target.value) } : entry) })} /></label><label>Max<input type="number" step="any" value={compensator.maximum} onChange={(event) => patchStudy({ compensators: study.compensators.map((entry) => entry.id === compensator.id ? { ...entry, maximum: finite(event.target.value) } : entry) })} /></label><button className="is-danger" type="button" onClick={() => patchStudy({ compensators: study.compensators.filter((entry) => entry.id !== compensator.id) })}>Remove</button></div>)}</div></details> : null}
    </section>

    <section className="tolerance-results">
      <div className="tolerance-result-heading"><strong>{analysisTitle} results</strong><span>Evaluated against the selected Requirements.</span></div>
      {!activeResult ? <div className="tolerance-empty-result">Run {mode === 'sensitivity' ? 'Sensitivity' : 'Tolerance'} to calculate results from the selected Requirements.</div> : null}
      {activeResult?.method === 'sensitivity' ? <SensitivityResultView result={activeResult} onDisableLowImpact={() => {
        const low = new Set(activeResult.parameters.filter((entry) => entry.impact < 0.01).map((entry) => entry.parameterId));
        patchStudy({ parameters: study.parameters.map((entry) => low.has(entry.id) ? { ...entry, enabled: false } : entry) });
      }} /> : null}
      {activeResult?.method === 'monte-carlo' ? <ToleranceResultView result={activeResult} onCreateWorst={createWorstConfig} /> : null}
    </section>
  </div>;
}

function SensitivityResultView({ result, onDisableLowImpact }: { result: SensitivityAnalysisResult; onDisableLowImpact: () => void }) {
  const maximum = Math.max(1e-12, ...result.parameters.filter((entry) => Number.isFinite(entry.impact)).map((entry) => entry.impact));
  return <div className="tolerance-result-content"><div className="tolerance-metrics"><MetricCard label="Nominal" value={result.nominal.passed ? 'Pass' : 'Fail'} /><MetricCard label="Parameters" value={String(result.parameters.length)} /><MetricCard label="Elapsed" value={`${(result.elapsedMs / 1000).toFixed(1)} s`} /><MetricCard label="Evaluation" value={result.execution?.backend === 'candidate-batch' ? 'Batched' : 'Fallback'} note={result.execution ? `${result.execution.candidateEvaluations} candidates · ${result.execution.candidateBatches} batches${result.execution.engines?.length ? ` · ${result.execution.engines.join(', ')}` : ''}` : undefined} /><button type="button" onClick={onDisableLowImpact}>Disable impact &lt; 1%</button></div><div className="tolerance-sensitivity-list">{result.parameters.map((entry) => {
    const width = Number.isFinite(entry.impact) ? Math.min(100, 100 * entry.impact / maximum) : 100;
    return <div className="tolerance-sensitivity-row" key={entry.parameterId}><div><strong>{entry.label}</strong><span>{Number.isFinite(entry.impact) ? `${(entry.impact * 100).toFixed(2)}% of nominal margin` : 'Invalid perturbed state'}</span></div><div className="tolerance-impact-track"><div className={Number.isFinite(entry.impact) ? '' : 'is-invalid'} style={{ width: `${width}%` }} /></div><small>Asymmetry {Number.isFinite(entry.nonlinearAsymmetry) ? percent(entry.nonlinearAsymmetry) : '—'}</small></div>;
  })}</div></div>;
}

function ToleranceResultView({ result, onCreateWorst }: { result: MonteCarloToleranceResult; onCreateWorst: () => void }) {
  return <div className="tolerance-result-content"><div className="tolerance-metrics"><MetricCard label="Overall yield" value={percent(result.yield)} note={`95% CI ${percent(result.yieldConfidence95.low)}–${percent(result.yieldConfidence95.high)}`} /><MetricCard label="Valid trials" value={`${result.validTrials}/${result.trialsCompleted}`} /><MetricCard label="Passed" value={String(result.passedTrials)} /><MetricCard label="Elapsed" value={`${(result.elapsedMs / 1000).toFixed(1)} s`} /><MetricCard label="Evaluation" value={result.execution?.backend === 'candidate-batch' ? 'Batched' : 'Fallback'} note={result.execution ? `${result.execution.candidateEvaluations} candidates · ${result.execution.candidateBatches} batches${result.execution.engines?.length ? ` · ${result.execution.engines.join(', ')}` : ''}` : undefined} /><MetricCard label="Seed" value={String(result.seed)} /><button type="button" onClick={onCreateWorst} disabled={!result.worstTrial}>Create Config from worst trial</button></div><div className="tolerance-table-wrap"><table className="tolerance-table"><thead><tr><th>Requirement</th><th>Yield</th><th>Mean</th><th>Std dev</th><th>P05</th><th>Median</th><th>P95</th></tr></thead><tbody>{result.requirements.map((entry) => <tr key={entry.requirementId}><td>{entry.requirementId}</td><td>{percent(entry.yield)}</td><td>{formatNumber(entry.mean)}</td><td>{formatNumber(entry.standardDeviation)}</td><td>{formatNumber(entry.p05)}</td><td>{formatNumber(entry.p50)}</td><td>{formatNumber(entry.p95)}</td></tr>)}</tbody></table></div></div>;
}

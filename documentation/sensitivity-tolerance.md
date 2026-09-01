# Sensitivity Analysis and Tolerance Analysis

`Analysis > Engineering` contains two separate windows. **Sensitivity Analysis** ranks local parameter effects, while **Tolerance Analysis** predicts manufacturing yield. Both use the same Requirements and saved Engineering Study data.

## Workflow

1. Define pass/fail rows in **Requirements**. Ordinary sequential operands and `ROUTE_*` Hybrid Assembly operands can be mixed.
2. Open **Sensitivity Analysis**, add parameters, and specify the negative/positive perturbation steps. The list is independent from Optimize `V` flags.
3. Run **Sensitivity** to rank the parameters, then disable negligible terms if appropriate.
4. Open **Tolerance Analysis**. The same Study and parameter list is already selected.
5. Replace the suggested tolerances with supplier or assembly data and choose each distribution.
6. Optionally add an image-focus or Detector-position compensator.
7. Run **Tolerance** for deterministic seeded Monte Carlo yield and per-Requirement statistics.
8. Use **Create Config from worst trial** to inspect a failing trial without changing the nominal Config.

Studies are stored in the project `SystemConfiguration.toleranceStudies` array and are preserved by Config save, duplication of the project JSON, and Web/Tauri reload.

## Calculation conventions

- Sensitivity uses an asymmetric central difference. Its step is a selectable fraction of the specified limits.
- Normal limits may represent `3 sigma` or `1 sigma`; uniform limits are the full negative/positive range.
- Yield is computed only from valid traces. Invalid, vignetted, TIR, or unreachable Route candidates fail deterministically and never reuse the previous trial.
- Compensation performs a bounded grid search for every trial. It changes only the temporary candidate.
- Monte Carlo uses a saved integer seed and reports the Wilson 95% interval for overall yield.
- Sequential and Hybrid Route Requirements are evaluated through one candidate adapter, using the same optical evaluator as the Requirements table. Browser builds use WASM-backed operands and Tauri uses the desktop backend selected by the existing evaluator.

The UI deliberately labels built-in tolerance values as estimates. They are not standards or supplier guarantees.

## Verification

Run:

```text
npm run diag:tolerance
npm run build
```

The diagnostic covers variable enumeration and mutation, analytic central sensitivity, deterministic Monte Carlo, zero-tolerance nominal reproduction, compensation improvement, Wilson confidence limits, and a mocked `ROUTE_OPL` candidate through Port-connection overrides.

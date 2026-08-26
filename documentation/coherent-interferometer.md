# Coherent signal analysis

This feature evaluates optical systems that split, route and recombine coherent light. It is driven entirely by the active Configuration: Design Intent blocks define physical components, Design Connections place them, Optical Routes select propagation paths, and Route Sets identify the measurement, reference and optional local-oscillator routes for a detector.

## Model boundary

There are no built-in instrument presets or embedded physical layouts. A new analysis starts from the user's current Configuration, and each source, beam splitter, grating, target, detector and route keeps the values entered in that Configuration.

The calculation currently supports:

- scalar complex field with separate phase and optical power;
- broadband and frequency-comb sources;
- ideal, plate, cube and pellicle beam-splitter models;
- reflection-grating direction, efficiency and optional detector-delay calibration;
- port-routed exact sequential groups and physical non-sequential components;
- area-detector W/pixel, electrons and ADU output;
- time-detector signals;
- flat-reference surface reconstruction when the required sampling and route metadata are available.

A non-propagating diffraction order is reported rather than clamped. Detector results include warnings when physical coverage, coherence-envelope sampling or RF Nyquist conditions are insufficient.

## Accuracy boundary

Coherent Signal reports the behavior of the configured model. Ideal lenses, scalar coatings, estimated component dimensions and omitted tolerances remain ideal assumptions; the analysis does not turn them into measured hardware performance. Quantitative use therefore requires real prescriptions, detector calibration, material/coating data and an error budget appropriate to the instrument.

Using separate configurations for transmitted and reflected rays remains useful for geometric debugging, but coherent interference requires the branches to be evaluated together through saved Optical Routes.

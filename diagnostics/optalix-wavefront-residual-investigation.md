# OpTaliX wavefront residual investigation

Date: 2026-07-15

## Scope

This note investigates why OpTaliX `WAV` RMS values are not reproduced by
co-opt's reference-sphere OPD grid followed by piston, tilt, or defocus removal.
The active design is `3G_IMAGE_F35_FNO_2.2_87_03.otx`; the attached model is
`3G_IMAGES_87_03.json`.

## Runtime direct-OPD evaluator

Read-only inspection of the authenticated V12.70 process located the packed
operand tokens and their parser branches:

| Operand | Token RVA | Parser RVA | Evaluator RVA |
| --- | ---: | ---: | ---: |
| `OPL` | `0xA70FD4` | `0xDCC32` | `0x39BFF0` |
| `OPD` | `0xA70FD8` | `0xDCCD6` | `0x39CA40` |
| `OPDW` | `0xA70FDC` | `0xDCD69` | `0x39CA40` |
| `PATH` | `0xA70FE4` | `0xDCDFC` | `0x39BFF0` |

`OPD` and `OPDW` select modes 0 and 1 of the same evaluator. Both reference
and sample executions call the same ray core at RVA `0x536FB0`. Direct `OPD`
then returns `global[C7A990] - global[C7AA20]`. For a captured Field 6 W1
sample, the two values were `31.1317906947436` and `31.1317921052888`; their
difference agrees with the native direct-OPD result to `4.3e-16 mm`.

The internal quantity is an OPL accumulator, but it is not the value returned
by the public `OPL` operand. The ray-core entry at RVA `0x536CC4` initializes
`C7AA18` and `C7AA20` to zero. Normal-surface code at RVA `0x5B2588` updates
them as `C7AA18 += ds` and `C7AA20 += abs(n * ds)`; other surface routines use
the same recurrence. The current-medium coefficient is loaded into `C7A9C0`
from per-surface refractive-index tables. Thus `C7AA18` is geometric path and
`C7AA20` is the core trace's optical path.

`OPL` and `PATH` nevertheless use the separate evaluator at RVA `0x39BFF0`,
select converted per-surface path arrays, and return a surface-range
difference. The native
Field 6/W1/+0.75 capture makes the distinction numerically decisive:

- public chief/sample `OPL`: `76.8875687652923 / 75.2189029847542 mm`
- public OPL difference: `+1.6686657805381 mm`
- direct `OPD`: `-1.765589104252285e-6 mm`

Therefore direct `OPD` is a difference between two full ray-core OPL
accumulations, not a subtraction of the public `OPL` operand results. The
reference path at RVA `0x5E5980` loads two values from wavelength-indexed arrays at
RVAs `0x480DEB8` and `0x480DF18`, passes them through the same ray initializer
at RVA `0x536330` used for sample rays, runs the shared ray core, applies the
image-side reference-surface correction at RVA `0x5E5B10`, and saves the
corrected `C7AA20` value to `C7A990` at RVA `0x5E5AF6`. For the active field
and wavelength index 2, these reference inputs are `(0, 5.808...)`, exactly
matching the two current sample-setup inputs. The evaluator copies the saved
reference-wavelength index from `C7B380` to the active index `C7B530`; the
cached arrays contain one nonzero seed per configured wavelength, confirming
that `C7B530` is a wavelength index rather than a field index.

The seed writer at RVA `0x4F8B10` makes the source explicit. It reads two
components for the active field from wavelength tables at RVAs `0x46C5060`
and `0x46CAD80`,
multiplies both by the common system scale at `C7A7B0`, and stores the results
in the two wavelength-indexed reference arrays. Its adjacent branches select either
the current wavelength index or the saved reference-wavelength index before
performing the same conversion. This is the runtime implementation of the
`RAIC` choice between aiming every wavelength and reusing reference-wavelength
aiming. The saved reference is therefore a scaled field launch/chief-ray seed,
not a normalized pupil coordinate or a separately fitted wavefront quantity.

The co-opt native OPD core already has the same high-level structure: it traces
a chief and sample ray, intersects both with an image-side reference sphere,
adds the corresponding `n * ds` correction, and subtracts chief minus sample.
The remaining compatibility problem is therefore narrower: determine how the
active-field, wavelength-indexed chief seed and image-side sphere are populated under `REF`,
`RAIC`, and `RAIM`, then select the corresponding existing co-opt launch and
reference-geometry modes without using the public `OPL` operand semantics.

The normal branch of the image-side correction at RVA `0x5E5B10` is now also
explicit. It transforms the traced point and direction into the final-surface
local frame, then intersects that ray with the spherical reference surface
defined by

```text
b = dot(point, direction) - R * direction.z
t = -b +/- sqrt(b*b - dot(point, point) + 2*R*point.z)
```

After selecting the native forward root, it updates `C7AA20` by
`abs(image_space_n) * t`. This is the ray/sphere intersection for a sphere of
radius `abs(R)` centered at local `(0, 0, R)` and passing through the local
origin. In the active unsaved OpTaliX state, `R` at `C7A998` is
`34.0866765396 mm`. The corresponding co-opt Field 6/W2 diagnostic generated
`33.5266904283 mm`, so the concrete remaining discrepancy is reference-sphere
construction (or the differing unsaved field state), not the intersection or
OPL-addition formula. The special `C7B4F0 != 0` branch replaces the sphere by
a `1e6 mm` near-plane radius and is not active in the captured normal path.

A focused co-opt rerun using the attached model, image-height-normalized object
rows, and Design Intent-derived entrance/exit pupils produced
`34.0909002949 mm` for Field 6/W2. This differs from the active unsaved OpTaliX
radius by `0.0042237553 mm` (`0.0124%`). The `optalix-direct` diagnostic mode
therefore uses the chief-image/exit-pupil image-side sphere. Treating the
pre-target state as the hit on the preceding physical surface produced
`10.1390570164 mm` and was rejected. Exact pointwise OPD parity still depends
on matching the active-field wavelength seed and `RAIC`/`RAIM` launch state.

## Observations

For Field 6, bare OpTaliX `WAV` reports:

| Wavelength (um) | RMS/lambda |
| ---: | ---: |
| 0.475 | 0.42446 |
| 0.550 | 1.02767 |
| 0.625 | 0.52679 |

The weighted total printed by the same command is 1.02619 waves. The native
file stores relative spectral weights `0.135 / 1.000 / 0.302`.

A fresh load of the same on-disk file reports `0.42050 / 0.99924 / 0.53158`
and 1.00707 weighted waves. The network source and the RAIM2 baseline fixture
have identical SHA-256 hashes, so this difference is unsaved runtime state in
the original long-lived OpTaliX session, not a fixture or file-content change.
All saved-setting A/B comparisons below use fresh loads of the byte-identical
disk baseline and are internally controlled.

Direct `OPD f6 wN x y` samples do not form the wavefront used by `WAV`:

- W2 direct OPD is zero at every captured meridional and sagittal sample.
- W1 and W3 direct OPD values are only about `1e-5 mm` or less.
- These samples cannot produce the reported W2 value of 1.02767 waves.

The native `.otx` file is plain text and stores these global settings:

```text
NRD 32 32
TGR 128 128
DVOM   1
RAIM   2
RAIC  1
```

`RAIM STO` reproduces the normal Field 6 `WAV` result. An attempted `RAIM TEL`
change reports finite-object/NAO errors but changes the subsequent result to
`0.03193 / 0.15866 / 0.16727` and 0.19413 weighted waves before `RAIM STO`
restores the original values. Therefore ray-aiming state participates directly
in `WAV` wavefront construction.

The `TLT` option does not change any Field 6 value. This rules out ordinary
tilt removal as the unexplained operation.

Across all 33 Field/wavelength cells, no tested co-opt display residual has a
useful correlation with OpTaliX:

| co-opt residual | Correlation | Cell MAE (waves) |
| --- | ---: | ---: |
| raw | 0.2454 | 0.4298 |
| piston | 0.2422 | 0.3142 |
| piston + defocus | 0.2228 | 0.3079 |
| piston + tilt + defocus | 0.2733 | 0.3015 |
| orthogonal entrance-pupil piston + defocus | 0.2544 | 0.2994 |

This is not the signature of a different least-squares basis or a small
defocus scaling difference.

## Stop-aiming test

co-opt was run with image-sphere reference, per-wavelength reference-sphere
geometry, per-wavelength exit pupil, grid 65, piston removal, and stop aiming.
Field 6 results were:

| Aiming | 0.475 um | 0.550 um | 0.625 um |
| --- | ---: | ---: | ---: |
| per-wavelength stop aim | 1.10955 | 0.77208 | 0.79054 |
| primary-fixed stop aim | 1.10881 | 0.77208 | 0.79049 |
| OpTaliX | 0.42446 | 1.02767 | 0.52679 |

Stop aiming alone is therefore insufficient. It confirms that the remaining
difference is in OpTaliX's wavefront construction under its saved aiming state,
not merely whether rays are numerically aimed at the stop.

## Saved-setting A/B tests

Native test files were generated from the same `.otx` source. Each A/B pair
differs only in the tested setting. The DVOM1 fixture is byte-identical to the
source; DVOM0 differs by the single ASCII byte `1` to `0`.

### RAIC 0 versus RAIC 1

`RAIC` changes direct `OPD` behavior but has only a very small effect on `WAV`:

| Field | Wavelength | RAIC 0 WAV | RAIC 1 WAV | RAIC 1 - 0 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.475 | 0.04656 | 0.04656 | 0.00000 |
| 1 | 0.550 | 0.25221 | 0.25221 | 0.00000 |
| 1 | 0.625 | 0.19326 | 0.19326 | 0.00000 |
| 6 | 0.475 | 0.42096 | 0.42050 | -0.00046 |
| 6 | 0.550 | 0.99924 | 0.99924 | 0.00000 |
| 6 | 0.625 | 0.53183 | 0.53158 | -0.00025 |
| 11 | 0.475 | 0.41465 | 0.41297 | -0.00168 |
| 11 | 0.550 | 0.72747 | 0.72747 | 0.00000 |
| 11 | 0.625 | 0.30121 | 0.30170 | +0.00049 |

With `RAIC 0`, every captured direct `OPD` sample is zero. With `RAIC 1`, W1
and W3 recover the small chromatic direct-OPD values while W2 remains zero.
`RAIC` therefore controls a direct-OPD chromatic correction or reference, but
it is not the source of the order-one `WAV` residual.

The V12.70 reference manual does not document the `RAIC` record name, but its
ray-aiming section documents the corresponding configuration checkbox, “Ray
aiming at ALL wavelengths.” When disabled, aiming is performed only at the
reference wavelength. This explains why `RAIC` affects only non-reference
colours and confirms that the direct `OPD` captures are coupled to chromatic
ray aiming.

Two simple reconstructions were tested against the complete Field 6
meridional capture and rejected:

- subtracting the primary-wavelength physical reference-sphere OPD grid from
	each colour produced a self-zero centre and pupil variation about two orders
	of magnitude too large;
- subtracting absolute OPLs traced from per-wavelength and
	reference-wavelength stop-aimed launches did force W2 to zero, but Field 6
	W1 gave `-6.98e-6 mm` instead of `-2.71e-6 mm` at the centre, while W3 had
	the wrong sign. The pupil-edge differences were much larger still.

Therefore `RAIC` identifies the controlling native path, but its direct `OPD`
correction cannot be reconstructed as a plain difference of the two available
co-opt launch OPLs. The OpTaliX table must not be relabelled as compatible
until this correction's exact reference planes and ray correspondence are
known.

The next native capture is
`diagnostics/optalix-opd-ray-geometry-capture.mac`. It records, for Field 6,
all three wavelengths and meridional pupil samples from -1 to +1:

- the direct `OPD` result;
- chief and sample intersections and direction cosines on the image surface;
- chief and sample `PATH` and `OPL` from surface 1 through surface 16.

The image coordinates and direction cosines will distinguish a reference
sphere intersection correction from a chief/sample OPL correction. If the
direct OPD equals a calculable combination of those quantities, the same
combination can be implemented in co-opt. If it does not, the remaining
unknown is an internal OpTaliX ray/reference convention rather than a missing
wavefront display option.

The existing `OPTALIX-WAV-OPD-PATH-PUPIL-CAPTURE.TXT` already shows why the
image geometry is necessary. At Field 6, W1, pupil `(0, 0.75)`, the
chief/sample full-path OPL difference through surface 16 is approximately
`1.668666 mm`, while direct OpTaliX `OPD` is only `-1.765589e-6 mm`. The large
path difference is therefore almost completely cancelled by an image-side
geometric/reference term. Surface-15 and surface-16 OPL intervals also differ,
so a correction based only on the final-surface OPL cannot be assumed.

The native `REF` A/B test adds another decisive constraint. With the same
Field 6 and pupil `(0, 0.75)`:

| Reference wavelength | W1 OPD (mm) | W2 OPD (mm) | W3 OPD (mm) |
| ---: | ---: | ---: | ---: |
| REF 1 | `0` | `-5.770060568e-6` | `-1.657842589e-5` |
| REF 2 | `-1.765589104e-6` | `0` | `-3.628594719e-6` |
| REF 3 | `-1.080613821e-5` | `-2.359152802e-6` | `0` |

Thus W2 being zero is not a coincidence or a missing sample ray. OpTaliX
sets the selected reference colour's direct OPD to zero across the pupil.
However, the other entries are not a simple scalar difference of the REF 2
values, so changing REF changes the reference construction itself, not merely
the final table offset. The production implementation must therefore resolve
the reference-wavelength ray/reference geometry before it can claim parity.

The native lens database query reports `SAP=-22.6702224888 mm`,
`SEP=11.4171015433 mm`, and `PRD=9.5085810577 mm` for this system. These are
the exit-pupil location, entrance-pupil location, and pupil relay distance.
They provide the physical scale for the reference sphere described by the
manual, but they do not by themselves reproduce the direct OPD values; the
chief-image center and reference-wavelength ray construction are still part
of the calculation.

Two further focused reconstructions were rejected at Field 6, pupil
`(0, 0.75)`. Pairing each current-colour sample with a separately stop-aimed
REF 2 ray reduced W3 to `-1.664811117e-5 mm`, but did not reach the native
`-3.628594719e-6 mm`; forcing the same aiming path on both sides collapsed all
three colours to zero, proving that this was merely self-subtraction. Using
co-opt's `primary-wavelength` sphere mode also failed: W1 changed to
`-1.455206445e-3 mm`, farther from the native `-1.765589104e-6 mm`, and the
reported sphere still varied by wavelength. Both experiments were reverted.

The next unresolved quantity is therefore not a generic sphere-mode switch or
a same-pupil REF ray. It is the exact native reference initializer output and
the image-side sphere state consumed by `0x5E5980`/`0x5E5B10` for each REF
selection. Those values must be captured at the correction call boundary
before another production formula is attempted.

Read-only inspection of the wavelength-indexed caches written by `0x5E5980`
confirms that the reference trace selects the saved REF index before loading
its seed and stores the initializer/ray-core output back into arrays indexed by
that same value. Under `REF 2`, W1 and W3 therefore share the REF 2 reference
trace; they do not use their current-colour chief as the native reference.
However, replacing co-opt's reference OPL with its independently traced W2
chief was also rejected: Field 6 `(0, 0.75)` remained
`-1.455878511e-3 mm` at W1 and `-6.303488289e-4 mm` at W3. The native values
are `-1.765589104e-6 mm` and `-3.628594719e-6 mm`. This isolates the remaining
three-order discrepancy to the current-colour sample initializer/reference
plane correspondence, not the final choice of chief OPL scalar.

The follow-up object-space capture is
`diagnostics/optalix-opd-object-space-capture.mac`. It records the surface-1
intersection and refracted direction for the same 27 Field 6 rays. Inverting
Snell's law with the J-LASFH22 catalog indices gives the same incident angle
for every pupil sample and wavelength:

`17.1565189483 degrees`, with less than `2.5e-10 degrees` spread.

This rejects wavelength-dependent field direction as the source of the
chromatic direct OPD. It also shows that co-opt's exact image-height solver
angle (`16.0300164955 degrees` for this field) is not the native OpTaliX field
construction used by this saved `FTYP 3` lens.

Two additional native A/B tests constrain the ray-aiming interpretation:

- Tightening `RAIT` from `1e-4` to `1e-7` changes the Field 6, pupil
	`(0, 0.75)` W1/W3 values by only about `1e-10 mm`. Direct OPD is therefore
	not an aiming convergence residual. `RAIT 1e-4` was restored.
- Switching from `RAIM STO` to non-iterative `RAIM ENP` does not zero direct
	OPD. At the same sample it gives W1 `2.165635980e-5 mm`, W2
	`-5.790608957e-4 mm`, and W3 `-7.249529509e-5 mm`. `RAIM STO` was restored
	and verified by the original W1 value and W2 zero.

The following co-opt reconstructions were also tested and rejected:

- current-wavelength minus primary-wavelength stop-aimer plane offsets;
- those plane offsets combined with the corresponding full traced OPL;
- actual-aim minus reference-aim OPL at every surface from object through
	image;
- retracing the actual-aim and reference-aim launch rays through the primary
	wavelength optical system.
- making `optalix-direct` default to current-wavelength stop aiming: at Field
	6 and pupil `(0, 0.75)`, W1/W3 were `-1.455878511e-3` and
	`-6.303488289e-4 mm`, versus native `-1.765589104e-6` and
	`-3.628594719e-6 mm`;
- replacing co-opt's solved Field 6 ImageHeight angle with the captured native
	incident angle `17.1565189483 deg`: W1/W3 remained
	`-1.455206943e-3` and `-6.286264420e-4 mm`.

The plane-offset candidate correctly makes W2 zero, but its W1/W3 values are
about `1e-3 mm`, roughly three orders larger than native direct OPD. None of
the surface or primary-retrace variants reduces this to parity. The remaining
unknown is therefore an OpTaliX construction that jointly depends on `REF`,
`RAIC`, and `RAIM`; it is not any single exposed launch, OPL, or reference-
sphere term tested so far.

## Geometry-matched W3 follow-up

A fresh OpTaliX load confirms the canonical Field 6/W3/pupil `(0, 0.75)`
direct value as `-3.628594718918521e-6 mm`. The earlier
`-3.8785177523e-6 mm` observation came from a long-lived unsaved runtime
state and is not the saved-file baseline.

Using the native incident angle `17.1565189483 degrees` and reversing the
meridional pupil convention (native `+0.75` maps to co-opt `-0.75`) matches
the native sample ray throughout the system. At surface 1, co-opt gives
`Y=2.5926863559 mm` and direction `Y/Z=0.1044217788/0.9945331026`; native
gives `Y=2.5926913351 mm` and `0.1044216695/0.9945331140`. The image-side
point and direction agree to approximately `1e-7`. The remaining W3 error is
therefore not sample-ray geometry.

With that matched ray, co-opt's current-colour chief reference gives
`-9.1262559261e-4 mm`. Reusing the primary-wavelength chief launch origin for
the W3 sample preserves the traced geometry but changes the result to
`+5.6715816530e-4 mm`, crossing the native value. This rejects raw launch-origin
substitution: the wavelength seed also defines the common OPL start plane and
must be transformed using the native initializer convention before tracing.
No production formula was changed.

### Runtime image reconnaissance

The authenticated process expands the protected 10.6 MB disk image to an
approximately 80.1 MB `MEM_IMAGE` mapping. Read-only process-memory scanning
found the following anchors in that expanded image:

- OPD format bytecode at module RVA `0xC0C5D0`;
- nearby `OPDW` bytecode at RVAs `0xC0C4D4` and `0xC0C548`;
- `RAIC` and `RAIM` records at RVAs `0xC18018` and `0xC180B8`;
- the rendered Text Window line in a separate output buffer near RVA
	`0x4575FA1`.

The first anchor is not a C string. Its bytes encode literal fragments plus
typed placeholders for Field, Colour, and the numeric result. Scans for
direct x64 RIP-relative `LEA` references and absolute pointers to these
runtime addresses found no references, consistent with an interpreter or
relocated table rather than a conventional static format-string call site.

Neighbor inspection confirms two separate tables. RVA `0xA70FDC` is inside a
packed operand-name dictionary containing `OPL`, `OPD`, `OPDW`, `PATH`, and
other analysis operands. RVA `0xC0C4D4` is inside a display-bytecode table
whose consecutive records format `OPDW ( Field ...)`, `OPDW ( Pos ...;
Field ...)`, and `OPD ( Field ...)`. The calculation is therefore likely
selected by the operand dictionary's ordinal through a parser/interpreter;
the display text is not a direct native-code call-site anchor.

WinDbg `-pv` non-invasive inspection can read this memory without changing
the process. An invasive debugger attach immediately triggers Sentinel HASP
`Debugger detected (E0030)` and terminates OpTaliX after acknowledgement.
Do not repeat invasive attach or attempt to bypass this protection. The lens
was reopened normally afterward, and `REF 2`, `RAIM STO`, and `RAIT 1e-4`
were restored; Field 6, Colour 2, pupil `(0, 0.75)` again returned exactly
`0.000000000 mm`.

### DVOM 0 versus DVOM 1

The complete captured outputs are identical: all nine WAV cells, all three
weighted Field values, and all 15 direct OPD samples match exactly. `DVOM` is
not involved in this wavefront residual path.

### RAIM 0 versus RAIM 1 versus RAIM 2

The `RAIM 0` and `RAIM 2` captures are byte-identical. They produce the same
nine WAV cells, weighted Field values, and direct OPD samples. `RAIM 2` is
therefore not a distinct third wavefront construction mode for this design.

`RAIM 1` changes the direct OPD path substantially, but its WAV effect remains
small. The largest WAV cell change is +0.00831 waves at Field 11, wavelength 3;
the largest weighted-Field change is +0.00749 waves at Field 11. This excludes
the saved `RAIM 2` digit as the source of the order-one WAV discrepancy.

### NRD 16 versus 32 versus 64 versus 128

`NRD` directly controls the ray set used by `WAV`. It changes WAV while all 15
captured direct OPD samples remain identical at every tested density:

| NRD | Field 6 W1 | Field 6 W2 | Field 6 W3 | Field 6 total | Field 11 W2 | Field 11 total |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 0.41235 | 0.97163 | 0.52452 | 0.98307 | 0.65745 | 0.68359 |
| 32 | 0.42050 | 0.99924 | 0.53158 | 1.00707 | 0.72747 | 0.74169 |
| 64 | 0.42314 | 0.99891 | 0.52945 | 1.00682 | 0.73198 | 0.74729 |
| 128 | 0.42357 | 0.99671 | 0.52802 | 1.00490 | 0.73807 | 0.75199 |

Field 11 shows strong low-density bias and convergence with increasing `NRD`.
Field 6 has smaller non-monotonic high-density variation, consistent with
discrete pupil-boundary or vignetting membership changing with density. This
is direct evidence that OpTaliX `WAV` traces and reduces a private pupil ray
set rather than sampling the direct `OPD` operand.

### TGR 64 versus 128 versus 256

All three complete outputs are byte-identical, including WAV and direct OPD.
`TGR` does not control the ray set or reduction used by `WAV`.

## Native system-wavefront export

The installed V12.70 reference manual documents `EXP WAV`, `WAV`, `WAVPV`,
`WAVZ`, and `NRAYS`. The documented command-line form of `EXP WAV` terminated
in both the Macro Editor and Floating Command Line, but the GUI path
`File / Export / System Wavefront` works. Its native menu command ID is 10057.
The Winteracter controls must be set through MSAA `IAccessible.accValue`;
`SetWindowTextW` changes their visible text without changing the values used by
the export.

Field 6, wavelength 2 was exported at NRD 16, 32, 64, and 128. ASCII `.txt`
uses five decimal places in mm. Native `.opd` is a text format with a
`550.00,7.95` header followed by integer pupil coordinates and six-decimal
wave values. The second header value agrees with the rounded entrance-pupil
radius: `EPD / 2 = 7.945371732... mm`. An attempted `.int` export did not
create a file.

For saved `NRD = N`, both formats contain an `(N + 1) x (N + 1)` endpoint
Cartesian grid. The grids are exactly nested: every NRD16 wave value equals
the corresponding even-coordinate NRD32 value, and the same equality holds
for 32 to 64 and 64 to 128. All comparisons match exactly at the six decimal
places stored by `.opd`. Increasing NRD inserts intermediate rays; it does not
change the existing reference-wavefront values.

| NRD | Grid | Nonzero OPD values | Unit-circle nodes | Unit-circle raw RMS | Native WAV |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 17 x 17 | 177 | 197 | 0.985115 | 0.97163 |
| 32 | 33 x 33 | 722 | 797 | 1.014277 | 0.99924 |
| 64 | 65 x 65 | 2898 | 3209 | 1.013062 | 0.99891 |
| 128 | 129 x 129 | 11575 | 12853 | 1.009633 | 0.99671 |

Ordinary piston or plane removal lowers the RMS too far. Conversely, a plain
unit-circle node average is consistently high. Dividing each full-grid sum of
squared wave values by the squared native WAV implies effective weights of
`202.506 / 821.168 / 3300.573 / 13188.452`. These non-integers rule out a
simple count of valid rays and point toward fractional boundary weights.

As a probe, each endpoint node was assigned its square Voronoi cell and
weighted by numerical cell/disk overlap. At a common pupil-radius scale of
1.0128, this reproduces native WAV within `0.000106 waves` at NRD64 and
`0.000004 waves` at NRD128. It does not reproduce NRD16 or NRD32, so 1.0128 is
not yet a recovered specification. The high-density agreement strongly
supports area-weighted pupil-boundary integration, while the low-density
results show that OpTaliX uses an additional discrete boundary approximation
or a mask not encoded explicitly by zero-filled `.opd` samples.

### Field 11 vignetting test

Field 11, wavelength 2 was exported at the same four densities. Its shared
node values are also exactly nested from NRD16 through NRD128, proving that
field vignetting does not make existing wave values density-dependent. The
Field 6 circular cell-area rule fails decisively at Field 11, underestimating
native WAV by about 0.09 waves at high density.

Treating nonzero export values as the validity mask and removing only their
mean gives the closest simple reduction:

| NRD | Nonzero nodes | Nonzero piston RMS | Native WAV | Difference |
| ---: | ---: | ---: | ---: | ---: |
| 16 | 127 | 0.668813 | 0.65745 | +0.011363 |
| 32 | 515 | 0.735650 | 0.72747 | +0.008180 |
| 64 | 2058 | 0.736046 | 0.73198 | +0.004066 |
| 128 | 8255 | 0.740106 | 0.73807 | +0.002036 |

The error approximately halves as NRD doubles. Plane removal is much too low,
and circular raw RMS remains about 0.65 waves. Odd-coordinate nodes from the
next finer export provide exact cell-center samples for the preceding density;
their nonzero piston RMS matches the NRD64 Field 11 target within 0.000678
waves. The lower-density center tests are less accurate, so cell-center
sampling is evidence for the asymptotic quadrature but not an exact recovered
algorithm.

Solving for a sample denominator that augments the nonzero endpoint set with
zero-valued boundary rays gives opposite corrections by field: Field 6 would
need to exclude some nonzero endpoints, while Field 11 would need to include
some zero endpoints. A single zero-count or enlarged-circle rule is therefore
excluded. The remaining operation is a field-dependent fractional quadrature
over the vignetted validity boundary, followed by piston removal.

### NRD256 and native ray counts

An `NRD 256 256` fixture loads successfully and exports 257 x 257 wavefronts.
Both Fields 6 and 11 remain exactly nested from NRD128 to NRD256 at all 16641
shared nodes. Native NRD256 W2 results are 0.99528 waves at Field 6 and 0.74011
waves at Field 11.

The lens-database item `NRAYS w2 fN` was captured through `Tools / Run macro`:

| NRD | Field 6 NRAYS / nonzero | Field 11 NRAYS / nonzero |
| ---: | ---: | ---: |
| 16 | 178 / 177 | 128 / 127 |
| 32 | 723 / 722 | 516 / 515 |
| 64 | 2899 / 2898 | 2059 / 2058 |
| 128 | 11576 / 11575 | 8256 / 8255 |
| 256 | 46280 / 46279 | 33015 / 33014 |

At all ten density/field combinations, the one additional valid ray is the
central chief ray, whose exported wave value is exactly zero. Thus native
`NRAYS` identifies the zero/nonzero export mask plus the valid center; it is
not a fractional integration denominator. Restoring that center at NRD256 and
computing population piston RMS gives 0.994598 and 0.741112 waves, still
differing from native WAV by -0.000682 and +0.001002.

NRD256 also directly rejects the simple cell-center hypothesis. Piston RMS on
the odd-coordinate NRD256 samples, which are exact centers of NRD128 cells,
differs from NRD128 native WAV by -0.002918 waves at Field 6 and +0.003261 at
Field 11. A reconstructed 128 x 128 endpoint-inclusive lattice is likewise
not common to both fields. Global trapezoidal weights have no effect because
valid rays do not reach the square-grid edge, while row/column validity-edge
half weights overcorrect strongly.

The endpoint-mask piston error continues to halve approximately with density:
at NRD256 it is -0.000673 waves for Field 6 and +0.001010 waves for Field 11.
This is consistent with a boundary quadrature error, but neither a simple
cell-center grid nor an endpoint trapezoid is the exact native rule.

A midpoint marching-squares probe was also applied to the verified binary
mask. It assigns boundary areas of 1/8, 1/2, and 7/8 cell for one, two, and
three valid corners, then distributes each cell area across its valid endpoint
values. At NRD256 it gives errors of -0.000691 waves at Field 6 and +0.000888
at Field 11. Fitting one common valid-to-invalid edge crossing fraction over
all ten cases selects 0.524 but retains opposite-sign field residuals. Binary
mask area alone is therefore insufficient; the next model must interpolate
the wave value inside partially valid cells rather than assigning their area
only to valid endpoints.

## Current conclusion

OpTaliX `WAV` is not an RMS reduction of values returned by the direct `OPD`
operand, and its unexplained behavior is not piston/tilt/defocus removal.
`RAIC`, `DVOM`, the saved `RAIM 2` value, and `TGR` have now been excluded as
the primary missing operation. `RAIC` and `RAIM 1` mainly affect the direct
OPD operand path; `DVOM` and `TGR` have no measurable effect here.

`NRD` is the first saved setting with a large, isolated effect on `WAV` and no
effect on direct `OPD`. The remaining discrepancy is therefore in OpTaliX's
private NRD-dependent pupil sampling, validity/vignetting mask, ray aiming, or
reference-wavefront construction before RMS reduction. It is not evidence of
an unimplemented residual polynomial subtraction.

The native export now narrows this further. The reference-wavefront values are
fixed on a nested Cartesian lattice, and most of the remaining WAV difference
is in pupil-boundary and vignetting-mask quadrature. Field 11 shows that native
WAV approaches piston-removed RMS over the valid, nonzero wavefront region;
ordinary plane/tilt removal and field-independent circular weighting are both
excluded. The formal meaning of `RAIC` remains unverified in the located
manual sections.

## Next experiment

Recover the exact fractional validity-boundary rule. Reconstruct the
zero/nonzero transition with marching-squares cell fractions and integrate
piston-removed wave values over that field-dependent mask. Use the verified
binary validity sets and ray counts to constrain ambiguous boundary cells
rather than fitting a free pupil-radius scale. Compare linear edge crossing at
half-cell, bilinear wave interpolation, and asymptotic convergence against all
ten native WAV values.

## Artifacts

- `diagnostics/results/OPTALIX-WAV-OPD-PATH-PUPIL-CAPTURE.TXT`
- `diagnostics/results/OPTALIX-WAV-PUPIL-CAPTURE.TXT`
- `diagnostics/results/OPTALIX-WAV-RAIM-AB.TXT`
- `diagnostics/fixtures/optalix-3g-images-87-03.json`
- `diagnostics/results/wav-raim-stop-per-wavelength.json`
- `diagnostics/results/wav-raim-stop-primary-fixed.json`
- `diagnostics/results/optalix-wav-raic0-capture.txt`
- `diagnostics/results/optalix-wav-raic1-capture.txt`
- `diagnostics/results/optalix-wav-dvom0-capture.txt`
- `diagnostics/results/optalix-wav-dvom1-capture.txt`
- `diagnostics/results/optalix-wav-raim0-capture.txt`
- `diagnostics/results/optalix-wav-raim1-capture.txt`
- `diagnostics/results/optalix-wav-raim2-capture.txt`
- `diagnostics/results/optalix-wav-nrd16-capture.txt`
- `diagnostics/results/optalix-wav-nrd64-capture.txt`
- `diagnostics/results/optalix-wav-nrd128-capture.txt`
- `diagnostics/results/optalix-wav-tgr64-capture.txt`
- `diagnostics/results/optalix-wav-tgr256-capture.txt`
- `diagnostics/results/optalix-wavefront-nrd16-f6-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd32-f6-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd64-f6-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd128-f6-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd16-f11-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd32-f11-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd64-f11-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd128-f11-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd256-f6-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd256-f11-w2.opd`
- `diagnostics/results/optalix-wavefront-nrd256-nrays-capture.txt`
- `diagnostics/results/optalix-wavefront-nrd16-nrays-capture.txt`
- `diagnostics/results/optalix-wavefront-nrd32-nrays-capture.txt`
- `diagnostics/results/optalix-wavefront-nrd64-nrays-capture.txt`
- `diagnostics/results/optalix-wavefront-nrd128-nrays-capture.txt`
- `diagnostics/fixtures/optalix-nrd-ab/3G_IMAGE_F35_FNO_2.2_87_03_NRD256.otx`
- `diagnostics/optalix-wavefront-nrays-capture.mac`
- `diagnostics/optalix-wavefront-grid-analyze.mjs`
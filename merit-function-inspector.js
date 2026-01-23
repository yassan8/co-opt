/**
 * System Evaluation Inspector Configuration
 * Manages operand definitions and inspector display logic
 */

// Operand definitions in JSON format
export const OPERAND_DEFINITIONS = {
  "ZERN_COEFF": {
    name: "Zernike Coefficient (Noll)",
    notes: "Measures meridional MTF at specified frequency. Target 1.0 for diffraction limit.",
    description: "Nth Zernike coefficient (Noll index) for the current system (live). n=0 returns RMS over coefficients.",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based, blank=Primary)" },
      { key: "param2", label: "Object idx", description: "Object row (1-based, default 1)" },
      { key: "param3", label: "Unit", description: "waves | um (default waves)" },
      { key: "param4", label: "Sampling", description: "OPD sampling grid (default 32)" },
      { key: "param5", label: "n (Noll)", description: "0 = RMS, 1-37 = coefficient index" }
    ],
    notes: "現在の光学系に対してOPDをサンプリングし、Zernikeフィットで係数を推定します。\n\n- Unit=waves: coefficientsWaves を使用\n- Unit=um: coefficientsMicrons を使用\n- Sampling: OPDサンプリングのグリッドサイズ（2の倍数: 32, 64, 128, 256, 512）\n\nparam5=0 の場合: piston(n=1) と tilt(n=2,3) を除いた係数の RMS を返します（RMS = sqrt(Σ c_n^2)）。\n\n注: この実装のNoll順では defocus は n=5 です（n=4 は m=-2 成分）。\n注: 重い評価です（最適化やRequirements更新で頻繁に呼ばれます）。"
  },
  "SPOT_SIZE_ANNULAR": {
    name: "Spot Size Annular (µm)",
    description: "Spot size (µm) using Spot Diagram-equivalent sampling, forced to Annular.",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based, blank=Primary)" },
      { key: "param2", label: "Object idx", description: "Object row (1-based, default 1)" },
      { key: "param3", label: "Metric", description: "'rms' or 'dia' (default 'rms')" },
      { key: "param4", label: "Rays", description: "Ray count (default 501)" }
    ],
    notes: "Spot Diagram と同じ生成経路（eva-spot-diagram.generateSpotDiagram）を使ってスポット点群を生成し、主光線基準でRMS/直径を計算します。\n\nRay pattern は Annular に固定します。Annular ring count は固定で 10。\n\nMetric: 'rms' または 'dia'（入力ゆれ許容: RMS/RMSTotal/R, Dia/Diam/D, Diameter）。\n定義: dia(diameter)=2*max(radius), rms=sqrt(mean(x^2)+mean(y^2))。単位µm。"
  },
  "SPOT_SIZE_RECT": {
    name: "Spot Size Rectangle (µm)",
    description: "Spot size (µm) using Spot Diagram-equivalent sampling, forced to Rectangle/Grid.",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based, blank=Primary)" },
      { key: "param2", label: "Object idx", description: "Object row (1-based, default 1)" },
      { key: "param3", label: "Metric", description: "'rms' or 'dia' (default 'rms')" },
      { key: "param4", label: "Rays", description: "Ray count (default 501)" }
    ],
    notes: "Spot Diagram と同じ生成経路（eva-spot-diagram.generateSpotDiagram）を使ってスポット点群を生成し、主光線基準でRMS/直径を計算します。\n\nRay pattern は Rectangle(Grid) に固定します。\n\nMetric: 'rms' または 'dia'（入力ゆれ許容: RMS/RMSTotal/R, Dia/Diam/D, Diameter）。\n定義: dia(diameter)=2*max(radius), rms=sqrt(mean(x^2)+mean(y^2))。単位µm。"
  },
  "LA_RMS_UM": {
    name: "Spherical Aberration RMS (µm)",
    description: "RMS of longitudinal aberration across pupil (µm), computed from the Spherical Aberration Diagram (meridional only).",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based) or wavelength in µm (blank=Primary)" }
    ],
    notes: "球面収差図（Spherical Aberration Diagram）のメリジオナル光線データから縦収差を集約してRMSを返します。\n\n定義（Option B）:\n- 縦収差 L(r) は図のX軸と同じ（最終面からの焦点位置までの距離, mm）\n- pupil coordinate r は正規化瞳座標（0..1）\n- 面積重み 2r dr で平均 L̄ を計算し、RMS = sqrt(E[(L-L̄)^2])\n- 返り値は µm（= mm * 1000）\n\nパラメータ: λ idx のみ（Sourceテーブル行番号, 1始まり）。空欄/0はPrimary Wavelength。\n\n注: 現状は meridional のみ（片側）で評価します。"
  },
  "FL": {
    name: "Focal Length (FL)",
    description: "Paraxial focal length (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataの近軸計算と同じ経路でFLを返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "EFL": {
    name: "Effective Focal Length (EFL)",
    description: "EFL = 1/α(final) with h[1]=1 (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param2", label: "Blocks", description: "blank/ALL = full system, or blockId list (comma/space separated)" }
    ],
    notes: "System Dataに表示しているEFL（h[1]=1なのでEFL=1/α[final]）を返します。\n\nBlocks(param2):\n- 空欄 / ALL: 全系EFL\n- blockId: そのブロック単体のEFL（ブロックを空気中のサブシステムとして評価）\n- blockId,blockId,... : 選択ブロック連結サブシステムのEFL（系内順序で抽出）\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "BFL": {
    name: "Back Focal Length (BFL)",
    description: "Back focal length (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataの近軸計算と同じ経路でBFLを返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "IMD": {
    name: "Image Distance",
    description: "Paraxial image distance (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System DataのImage Distanceを返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "OBJD": {
    name: "Object Distance",
    description: "Object distance from Object thickness",
    parameters: [
      { key: "param1", label: "Reserved", description: "Unused" }
    ],
    notes: "Object面のthickness（mm）をそのまま返します。INF/Infinityの場合は評価値として0を返します（NaN回避）。"
  },
  "TSL": {
    name: "Total System Length",
    description: "Sum of all finite thicknesses (System Data)",
    parameters: [
      { key: "param1", label: "Reserved", description: "Unused" }
    ],
    notes: "Optical System表のthicknessを合計した全長(mm)を返します。INF/Infinityは合計に含めません。"
  },
  "BEXP": {
    name: "Exit Pupil Magnification (βexp)",
    description: "Exit pupil magnification (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで使用している射出瞳倍率（βexp）を返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "EXPD": {
    name: "Exit Pupil Diameter (ExPD)",
    description: "Exit pupil diameter in mm (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示している射出瞳径(mm)を返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "EXPP": {
    name: "Exit Pupil Position (from Image)",
    description: "Exit pupil position from Image plane (mm)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataの「Exit Pupil Position: ... (from Image)」と同じ定義（posOrigin - imageDistance）で返します。"
  },
  "ENPD": {
    name: "Entrance Pupil Diameter (EnPD)",
    description: "Entrance pupil diameter in mm (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示している入射瞳径(mm)を返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "ENPP": {
    name: "Entrance Pupil Position",
    description: "Entrance pupil position (mm)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示している入射瞳位置(mm)を返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "ENPM": {
    name: "Entrance Pupil Magnification",
    description: "Entrance pupil magnification (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示している入射瞳倍率を返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "PMAG": {
    name: "Paraxial Magnification",
    description: "Paraxial magnification β (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示している近軸倍率βを返します。有限物体ではβ=α[1]/α[final]（h[1]=1, n=1）、無限物体(INF)は0を返します。"
  },
  "FNO_OBJ": {
    name: "Object Space F#",
    description: "Object space F-number (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示しているObject Space F#を返します。"
  },
  "FNO_IMG": {
    name: "Image Space F#",
    description: "Image space F-number (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示しているImage Space F#を返します。"
  },
  "FNO_WRK": {
    name: "Paraxial Working F#",
    description: "Working F-number (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示しているParaxial Working F#を返します。"
  },
  "NA_OBJ": {
    name: "Object Space NA",
    description: "Object space numerical aperture (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示しているObject Space NAを返します。"
  },
  "NA_IMG": {
    name: "Image Space NA",
    description: "Image space numerical aperture (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" }
    ],
    notes: "System Dataで表示しているImage Space NAを返します。"
  },
  "CLRH": {
    name: "Clearance vs SemiDia",
    description: "Clearance constraint: max(0, |rayY| + margin - semidia)",
    parameters: [
      { key: "param1", label: "Surface", description: "Surface number (Optical System id)" },
      { key: "param2", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param3", label: "Margin", description: "Margin (mm, default 0)" },
      { key: "param4", label: "Reserved", description: "Reserved" }
    ],
    notes: "Returns a non-negative constraint violation in mm: max(0, |rayY| + margin - semidia).\n\nrayY is taken from REAL ray tracing (cross-ray style): we solve a ray that hits the STOP edge (Y=+StopSemiDia) and then read the ray Y at the specified surface. Use Target=0 and a large Weight to enforce clearance.\n\nSurface: Optical System Surface number (id).\nλ: Source table row (1-based). Blank uses Primary.\nMargin: Additional clearance (mm)."
  },
  "TOT3_SPH": {
    name: "3rd Order Spherical",
    description: "3rd-order spherical aberration",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "S1", description: "Surface (0=Total)" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nS1: 0 returns the system total; otherwise returns the value at the specified surface.\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_COMA": {
    name: "3rd Order Coma",
    description: "3rd-order coma aberration",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "S1", description: "Surface (0=Total)" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nS1: 0 returns the system total; otherwise returns the value at the specified surface.\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_ASTI": {
    name: "3rd Order Astigmatism",
    description: "3rd-order astigmatism",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "S1", description: "Surface (0=Total)" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nS1: 0 returns the system total; otherwise returns the value at the specified surface.\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_FCUR": {
    name: "3rd Order Field Curvature",
    description: "3rd-order field curvature",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "S1", description: "Surface (0=Total)" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nS1: 0 returns the system total; otherwise returns the value at the specified surface.\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_DIST": {
    name: "3rd Order Distortion",
    description: "3rd-order distortion",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "S1", description: "Surface (0=Total)" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nS1: 0 returns the system total; otherwise returns the value at the specified surface.\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT_LCA": {
    name: "Longitudinal Chromatic",
    description: "Longitudinal chromatic aberration",
    parameters: [
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "S1", description: "Surface (0=Total)" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nUses System Data wavelength settings (no λ parameter).\nMode: 0=Imaging, 1=Afocal.\nS1: 0 returns the system value; otherwise returns the value at the specified surface.\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT_TCA": {
    name: "Transverse Chromatic",
    description: "Transverse chromatic aberration",
    parameters: [
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "S1", description: "Surface (0=Total)" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nUses System Data wavelength settings (no λ parameter).\nMode: 0=Imaging, 1=Afocal.\nS1: 0 returns the system value; otherwise returns the value at the specified surface.\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "EFFL": {
    name: "Effective Focal Length (S1–S2)",
    description: "Effective focal length for a surface range (S1–S2)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "S1", description: "Start Surface" },
      { key: "param3", label: "S2", description: "End Surface" }
    ],
    notes: "開始面から終了面までの有効焦点距離を計算します。面の指定はOptical SystemテーブルのSurface番号（id値）を使用します。\n\nλ: Sourceテーブルの行番号（1始まり）で波長を指定します。例：λ=1でSource1行目の波長、λ=2でSource2行目の波長を使用。\n\nS1（開始面）: Surface番号で指定。S1=0（Object面）の場合、実際のObject面のthickness値を使用します（有限系または無限系）。S1>0（途中の面から開始）の場合、thickness=Infinityの仮想Object面を作成し、無限共役で計算します。\n\nS2（終了面）: Surface番号で指定。省略時は最終面の1つ前が使用されます。"
  },
  "REAY": {
    name: "REAY",
    description: "Real Ray Y-coordinate",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Pupil X" },
      { key: "param3", label: "Pupil Y" },
      { key: "param4", label: "Field" }
    ],
    notes: "Traces a real ray and returns the Y-coordinate at the specified surface. Useful for controlling ray positions."
  },
  "RSCE": {
    name: "RSCE",
    description: "Ray Surface to Surface Distance",
    parameters: [
      { key: "param1", label: "Start Surf" },
      { key: "param2", label: "End Surf" },
      { key: "param3", label: "Pupil X" },
      { key: "param4", label: "Pupil Y" }
    ],
    notes: "Measures the distance a ray travels between two surfaces. Used for path length constraints."
  },
  "TRAC": {
    name: "TRAC",
    description: "Transverse Ray Aberration",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Field" },
      { key: "param3", label: "Pupil X" },
      { key: "param4", label: "Pupil Y" }
    ],
    notes: "Calculates transverse ray aberration at image surface. Essential for aberration correction."
  },
  "DIST": {
    name: "DIST",
    description: "Distortion",
    parameters: [
      { key: "param1", label: "Field" },
      { key: "param2", label: "Type (0=%, 1=abs)" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Controls optical distortion at specified field point. Target 0 for no distortion."
  },
  "COMA": {
    name: "COMA",
    description: "Coma Aberration",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Field" },
      { key: "param3", label: "Component (X/Y)" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Measures coma aberration at specified surface and field. Critical for off-axis performance."
  },
  "SPHA": {
    name: "SPHA",
    description: "Spherical Aberration",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Zone Height" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Controls spherical aberration at specified zone. Essential for on-axis image quality."
  },
  "POPD": {
    name: "POPD",
    description: "Optical Path Difference",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Field" },
      { key: "param3", label: "Pupil X" },
      { key: "param4", label: "Pupil Y" }
    ],
    notes: "Measures wavefront OPD at specified pupil coordinate. Target 0 for perfect wavefront."
  },
  "TTHI": {
    name: "TTHI",
    description: "Total Track Thickness",
    parameters: [
      { key: "param1", label: "Start Surf" },
      { key: "param2", label: "End Surf" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Controls total distance between surfaces. Used for packaging constraints."
  },
  "CVGT": {
    name: "CVGT",
    description: "Curvature Greater Than",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Min Radius" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Ensures surface curvature stays above minimum value. Prevents excessive curvature."
  },
  "CVLT": {
    name: "CVLT",
    description: "Curvature Less Than",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Max Radius" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Ensures surface curvature stays below maximum value. Prevents flat surfaces."
  },
  "MTFS": {
    name: "MTFS",
    description: "MTF Sagittal",
    parameters: [
      { key: "param1", label: "Frequency (lp/mm)" },
      { key: "param2", label: "Field" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Measures sagittal MTF at specified frequency. Target 1.0 for diffraction limit."
  },
  "MTFT": {
    name: "MTFT",
    description: "MTF Meridional",
    parameters: [
      { key: "param1", label: "Frequency (lp/mm)" },
      { key: "param2", label: "Field" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Measures meridional MTF at specified frequency. Target 1.0 for diffraction limit."
  },
  "EDGE": {
    name: "EDGE",
    description: "Edge Thickness",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Height" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Controls edge thickness at specified height. Prevents lens manufacturing issues."
  },
  "CTGT": {
    name: "CTGT",
    description: "Center Thickness Greater Than",
    parameters: [
      { key: "param1", label: "Surface" },
      { key: "param2", label: "Min Thickness" },
      { key: "param3", label: "Reserved" },
      { key: "param4", label: "Reserved" }
    ],
    notes: "Ensures center thickness stays above minimum. Important for mechanical stability."
  }
};

// Only expose operands that are implemented and intended for the UI.
// Keep other definitions for backward compatibility / future work, but hide them from dropdowns.
const VISIBLE_OPERANDS_IN_UI = new Set([
  'FL', 'EFL', 'BFL', 'IMD', 'OBJD', 'TSL',
  'BEXP', 'EXPD', 'EXPP',
  'ENPD', 'ENPP', 'ENPM',
  'PMAG',
  'FNO_OBJ', 'FNO_IMG', 'FNO_WRK',
  'NA_OBJ', 'NA_IMG',
  'EFFL',
  'TOT3_SPH', 'TOT3_COMA', 'TOT3_ASTI', 'TOT3_FCUR', 'TOT3_DIST',
  'TOT_LCA', 'TOT_TCA',
  'CLRH',
  'SPOT_SIZE_ANNULAR', 'SPOT_SIZE_RECT',
  'LA_RMS_UM',
  'ZERN_COEFF'
]);

/**
 * Inspector Display Manager
 * Handles the rendering and updating of the operand inspector panel
 */
export class InspectorManager {
  constructor(inspectorElementId = 'operand-inspector', contentElementId = 'inspector-content') {
    this.inspectorElement = document.getElementById(inspectorElementId);
    this.contentElement = document.getElementById(contentElementId);
    
    if (!this.inspectorElement || !this.contentElement) {
      console.warn('Inspector elements not found in DOM');
    }
  }
  
  /**
   * Show inspector with operand data
   * @param {Object} data - Row data from Tabulator
   */
  show(data) {
    if (!this.inspectorElement || !this.contentElement) return;
    
    const operandType = data.operand;
    const definition = OPERAND_DEFINITIONS[operandType];
    
    if (!definition) {
      this.contentElement.innerHTML = `
        <div class="inspector-row">
          <strong>Unknown Evaluation Function:</strong> ${operandType}
        </div>
      `;
      this.inspectorElement.style.display = 'block';
      return;
    }
    
    // Build inspector HTML
    let html = `
      <div class="inspector-row">
        <strong>Evaluation Function:</strong> ${definition.name}
      </div>
      <div class="inspector-row">
        <strong>Description:</strong> ${definition.description}
      </div>
      <div class="inspector-row">
        <strong>Context Role:</strong> ${data.contextRole || 'Unassigned'}
      </div>
    `;
    
    // Add parameter rows with descriptions
    definition.parameters.forEach(param => {
      const value = data[param.key] !== undefined ? data[param.key] : '-';
      const description = param.description ? ` (${param.description})` : '';
      html += `
        <div class="inspector-row" style="padding-left: 20px;">
          <strong>${param.label}${description}:</strong> ${value}
        </div>
      `;
    });
    
    // Add target and weight
    html += `
      <div class="inspector-row">
        <strong>Target:</strong> ${data.target !== undefined ? data.target : '-'}
      </div>
      <div class="inspector-row">
        <strong>Weight:</strong> ${data.weight !== undefined ? data.weight : '-'}
      </div>
    `;
    
    // Add current value if available
    if (data.value !== undefined && data.value !== '') {
      html += `
        <div class="inspector-row">
          <strong>Current Value:</strong> ${data.value}
        </div>
      `;
    }
    
    // Add notes
    if (definition.notes) {
      html += `
        <div class="inspector-row">
          <div class="inspector-note">${definition.notes}</div>
        </div>
      `;
    }
    
    this.contentElement.innerHTML = html;
    this.inspectorElement.style.display = 'block';

    // Optional interactive helpers
    try {
      this._installEflBlockPickerIfNeeded(data);
    } catch (_) {}
  }

  _installEflBlockPickerIfNeeded(data) {
    const operandType = data?.operand;
    if (operandType !== 'EFL') return;

    const rowId = data?.id;
    if (rowId === undefined || rowId === null) return;

    const blocks = this._getBlocksForConfigHint(data?.configId);
    if (!Array.isArray(blocks) || blocks.length === 0) {
      this._appendInspectorHtml(`
        <div class="inspector-row">
          <strong>Blocks:</strong> (no blocks available)
        </div>
      `);
      return;
    }

    const displayLabelById = (() => {
      const labelById = new Map();
      try {
        const counts = new Map();
        for (const b of blocks || []) {
          if (!b || typeof b !== 'object') continue;
          const id = String(b.blockId ?? '').trim();
          if (!id) continue;
          const tRaw = String(b.blockType ?? '').trim();
          if (!tRaw) continue;
          if (tRaw === 'ObjectPlane' || tRaw === 'ImagePlane') {
            labelById.set(id, tRaw);
            continue;
          }
          const baseType = (tRaw === 'PositiveLens') ? 'Lens' : tRaw;
          const next = (counts.get(baseType) || 0) + 1;
          counts.set(baseType, next);
          labelById.set(id, `${baseType}-${next}`);
        }
      } catch (_) {}
      return labelById;
    })();

    const selRaw = (data?.param2 !== undefined && data?.param2 !== null) ? String(data.param2).trim() : '';
    const explicitAll = (!selRaw || /^all$/i.test(selRaw) || /^full$/i.test(selRaw));
    const selectedIds = new Set(
      explicitAll
        ? blocks.map(b => String(b?.blockId ?? '').trim()).filter(Boolean)
        : selRaw.split(/[,\s]+/).map(s => String(s).trim()).filter(Boolean)
    );

    const listId = `coopt-efl-block-picker-${String(rowId)}`;
    const allId = `${listId}-all`;

    const blockItems = blocks
      .map((b, idx) => {
        const bid = String(b?.blockId ?? '').trim();
        if (!bid) return '';
        const btype = String(b?.blockType ?? '').trim();
        const checked = selectedIds.has(bid) ? 'checked' : '';
        const cid = `${listId}-b-${idx}`;
        const disp = displayLabelById.get(bid) || bid;
        const label = btype ? `${disp} (${btype})` : disp;
        return `
          <label style="display:flex; gap:8px; align-items:center; padding:2px 0;">
            <input type="checkbox" id="${cid}" data-block-id="${bid}" ${checked} />
            <span>${label}</span>
          </label>
        `;
      })
      .filter(Boolean)
      .join('');

    const allChecked = selectedIds.size >= blocks.filter(b => String(b?.blockId ?? '').trim()).length;

    this._appendInspectorHtml(`
      <div class="inspector-row">
        <strong>Blocks:</strong>
        <div id="${listId}" style="margin-top:6px; padding:6px 8px; border:1px solid #ddd; border-radius:4px; background:#fafafa;">
          <label style="display:flex; gap:8px; align-items:center; padding:2px 0; font-weight:600;">
            <input type="checkbox" id="${allId}" ${allChecked ? 'checked' : ''} />
            <span>ALL</span>
          </label>
          <div style="margin-top:6px; max-height:180px; overflow:auto;">
            ${blockItems}
          </div>
          <div style="margin-top:6px; color:#666; font-size:12px;">Selected blockId(s) are written to param2.</div>
        </div>
      </div>
    `);

    const root = this.contentElement.querySelector(`#${CSS.escape(listId)}`);
    if (!root) return;

    const setParam2 = (nextVal) => {
      try {
        const sre = window.systemRequirementsEditor;
        if (!sre || !sre.table || typeof sre.table.updateData !== 'function') return;
        sre.table.updateData([{ id: rowId, param2: nextVal }]);
        if (typeof sre.saveToStorage === 'function') sre.saveToStorage();
        if (typeof sre.scheduleEvaluateAndUpdate === 'function') sre.scheduleEvaluateAndUpdate();
      } catch (_) {}
    };

    const computeSelection = () => {
      const checked = Array.from(root.querySelectorAll('input[type="checkbox"][data-block-id]'))
        .filter(el => el && el.checked)
        .map(el => String(el.getAttribute('data-block-id') || '').trim())
        .filter(Boolean);

      // If none selected, treat as ALL (full system) to avoid empty/ambiguous state.
      if (checked.length === 0) return 'ALL';

      const allIds = blocks.map(b => String(b?.blockId ?? '').trim()).filter(Boolean);
      const allSelected = checked.length >= allIds.length;
      return allSelected ? 'ALL' : checked.join(',');
    };

    const allBox = root.querySelector(`#${CSS.escape(allId)}`);
    if (allBox) {
      allBox.addEventListener('change', () => {
        const wantAll = !!allBox.checked;
        for (const el of root.querySelectorAll('input[type="checkbox"][data-block-id]')) {
          el.checked = wantAll;
        }
        setParam2('ALL');
      });
    }

    for (const el of root.querySelectorAll('input[type="checkbox"][data-block-id]')) {
      el.addEventListener('change', () => {
        const next = computeSelection();
        // Sync ALL checkbox
        try {
          if (allBox) allBox.checked = /^all$/i.test(String(next));
        } catch (_) {}
        setParam2(next);
      });
    }
  }

  _appendInspectorHtml(fragmentHtml) {
    if (!this.contentElement) return;
    const div = document.createElement('div');
    div.innerHTML = String(fragmentHtml || '');
    while (div.firstChild) {
      this.contentElement.appendChild(div.firstChild);
    }
  }

  _getBlocksForConfigHint(configIdHint) {
    try {
      let sys = null;
      try {
        if (typeof loadSystemConfigurationsFromTableConfig === 'function') {
          sys = loadSystemConfigurationsFromTableConfig();
        } else if (typeof window !== 'undefined' && window.ConfigurationManager && typeof window.ConfigurationManager.loadSystemConfigurations === 'function') {
          sys = window.ConfigurationManager.loadSystemConfigurations();
        } else if (typeof loadSystemConfigurations === 'function') {
          sys = loadSystemConfigurations();
        }
      } catch (_) {
        sys = null;
      }
      if (!sys) {
        const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem('systemConfigurations') : null;
        sys = raw ? JSON.parse(raw) : null;
      }
      const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
      const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null) ? String(sys.activeConfigId) : '';

      const hintRaw = (configIdHint === undefined || configIdHint === null) ? '' : String(configIdHint).trim();
      let cfg = null;

      if (hintRaw) {
        cfg = configs.find(c => c && String(c.id) === hintRaw) || configs.find(c => c && String(c.name).trim() === hintRaw) || null;
      }
      if (!cfg && activeId) {
        cfg = configs.find(c => c && String(c.id) === activeId) || null;
      }
      if (!cfg) cfg = configs[0] || null;

      const blocks = cfg && Array.isArray(cfg.blocks) ? cfg.blocks : null;
      return Array.isArray(blocks) ? blocks : [];
    } catch (_) {
      return [];
    }
  }
  
  /**
   * Hide inspector panel
   */
  hide() {
    if (this.inspectorElement) {
      this.inspectorElement.style.display = 'none';
    }
  }
  
  /**
   * Update inspector with new data
   * @param {Object} data - Updated row data
   */
  update(data) {
    if (this.inspectorElement && this.inspectorElement.style.display === 'block') {
      this.show(data);
    }
  }
  
  /**
   * Get list of available operand types
   * @returns {Array} Array of operand type names
   */
  static getAvailableOperands() {
    return Object.keys(OPERAND_DEFINITIONS).filter((k) => VISIBLE_OPERANDS_IN_UI.has(k));
  }
  
  /**
   * Get definition for specific operand type
   * @param {string} operandType - Operand type name
   * @returns {Object|null} Operand definition or null if not found
   */
  static getOperandDefinition(operandType) {
    return OPERAND_DEFINITIONS[operandType] || null;
  }
  
  /**
   * Add new operand definition dynamically
   * @param {string} type - Operand type name
   * @param {Object} definition - Operand definition object
   */
  static addOperandDefinition(type, definition) {
    if (!definition.name || !definition.description || !definition.parameters) {
      console.error('Invalid operand definition format');
      return false;
    }
    
    OPERAND_DEFINITIONS[type] = definition;
    console.log(`✅ Added operand definition: ${type}`);
    return true;
  }
  
  /**
   * Validate operand data against definition
   * @param {string} operandType - Operand type name
   * @param {Object} data - Row data to validate
   * @returns {Object} Validation result with isValid and errors
   */
  static validateOperandData(operandType, data) {
    const definition = OPERAND_DEFINITIONS[operandType];
    
    if (!definition) {
      return {
        isValid: false,
        errors: [`Unknown operand type: ${operandType}`]
      };
    }
    
    const errors = [];
    
    // Check required fields
    if (data.target === undefined || data.target === '') {
      errors.push('Target value is required');
    }
    
    if (data.weight === undefined || data.weight === '') {
      errors.push('Weight value is required');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

// Export for console access
if (typeof window !== 'undefined') {
  window.InspectorManager = InspectorManager;
  window.OPERAND_DEFINITIONS = OPERAND_DEFINITIONS;
}

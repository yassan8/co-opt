// Typed window reference to avoid TypeScript 'as any' syntax in compiled output
declare global {
  interface Window {
    [key: string]: any;
  }
}
const w: Record<string, any> = window;

import { loadSystemConfigurations } from '../../data/table-configuration.ts';

function tryLoadSystemConfigurations(): any {
  try {
    if (typeof localStorage === 'undefined') return null;
    return loadSystemConfigurations();
  } catch {
    return null;
  }
}

/**
 * System Evaluation Inspector Configuration
 * Manages operand definitions and inspector display logic
 */

// Operand definitions in JSON format
// Order: 1. Paraxial (近軸) → 2. 3rd Order Aberrations → 3. Analysis
export const OPERAND_DEFINITIONS: Record<string, any> = {
  // ===== Paraxial (近軸関連) =====
  "FL": {
    name: "Focal Length (FL)",
    description: "Paraxial focal length (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param2", label: "Axis", description: "blank=Default, X=sagittal/XZ, Y=tangential/YZ" }
    ],
    notes: "System Dataの近軸計算と同じ経路でFLを返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "EFL": {
    name: "Effective Focal Length (EFL)",
    description: "EFL = 1/α(final) with h[1]=1 (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param2", label: "Blocks", description: "blank/ALL = full system, or blockId list (comma/space separated)" },
      { key: "param3", label: "Axis", description: "blank=Default, X=sagittal/XZ, Y=tangential/YZ" }
    ],
    notes: "System Dataに表示しているEFL（h[1]=1なのでEFL=1/α[final]）を返します。\n\nBlocks(param2):\n- 空欄 / ALL: 全系EFL\n- blockId: そのブロック単体のEFL（ブロックを空気中のサブシステムとして評価）\n- blockId,blockId,... : 選択ブロック連結サブシステムのEFL（系内順序で抽出）\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "PP1": {
    name: "Front Principal Point (PP1)",
    description: "Front principal point position from the first surface of the selected subsystem",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param2", label: "S1", description: "Start Surface" },
      { key: "param3", label: "S2", description: "End Surface" },
      { key: "param4", label: "Mode", description: "blank=Surface range, ZG=Zoom Group" }
    ],
    notes: "開始面 S1 から終了面 S2 までのレンズ群、または指定した Zoom Group の範囲を空気中のサブシステムとして評価し、先頭面を 0 mm としたときの前側主点位置(mm)を返します。\n\n前側主点側は、選択サブシステムを反転した近軸 reverse trace から前側焦点距離を求め、その結果から主点位置を算出します。\n\n指定方法:\n- Surface range: param2=S1, param3=S2, param4=空欄\n- Zoom Group: param2=zoom group名, param4=ZG\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "PP2": {
    name: "Rear Principal Point (PP2)",
    description: "Rear principal point position from the last surface of the selected subsystem",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param2", label: "S1", description: "Start Surface" },
      { key: "param3", label: "S2", description: "End Surface" },
      { key: "param4", label: "Mode", description: "blank=Surface range, ZG=Zoom Group" }
    ],
    notes: "開始面 S1 から終了面 S2 までのレンズ群、または指定した Zoom Group の範囲を空気中のサブシステムとして評価し、最終面を 0 mm としたときの後側主点位置(mm)を返します。\n\n指定方法:\n- Surface range: param2=S1, param3=S2, param4=空欄\n- Zoom Group: param2=zoom group名, param4=ZG\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "BFL": {
    name: "Back Focal Length (BFL)",
    description: "Back focal length (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param2", label: "Axis", description: "blank=Default, X=sagittal/XZ, Y=tangential/YZ" }
    ],
    notes: "System Dataの近軸計算と同じ経路でBFLを返します。\n\nλ: Source行番号(1始まり)。空欄/0の場合はPrimary Wavelength。"
  },
  "EFFL": {
    name: "Effective Focal Length (S1–S2)",
    description: "Effective focal length for a surface range (S1–S2)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "S1", description: "Start Surface" },
      { key: "param3", label: "S2", description: "End Surface" },
      { key: "param4", label: "Axis", description: "blank=Default, X=sagittal/XZ, Y=tangential/YZ" }
    ],
    notes: "開始面から終了面までの有効焦点距離を計算します。面の指定はOptical SystemテーブルのSurface番号（id値）を使用します。\n\nλ: Sourceテーブルの行番号（1始まり）で波長を指定します。例：λ=1でSource1行目の波長、λ=2でSource2行目の波長を使用。\n\nS1（開始面）: Surface番号で指定。S1=0（Object面）の場合、実際のObject面のthickness値を使用します（有限系または無限系）。S1>0（途中の面から開始）の場合、thickness=Infinityの仮想Object面を作成し、無限共役で計算します。\n\nS2（終了面）: Surface番号で指定。省略時は最終面の1つ前が使用されます。"
  },
  "IMD": {
    name: "Image Distance",
    description: "Paraxial image distance (System Data)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (blank=Primary)" },
      { key: "param2", label: "Axis", description: "blank=Default, X=sagittal/XZ, Y=tangential/YZ" }
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
  "DBLT_K": {
    name: "Doublet Bending K",
    description: "Common curvature offset K added to C1/C2/C3 of a Doublet",
    parameters: [
      { key: "param1", label: "Doublet", description: "Doublet blockId or display label" }
    ],
    notes: "For a Doublet, K is defined by C1' = C1 + K, C2' = C2 + K, C3' = C3 + K. This preserves Φ1=(N1-1)(C1-C2) and Φ2=(N2-1)(C2-C3), so thin-lens power split and achromat condition stay unchanged while shape bends." 
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
  
  // ===== 3rd Order Aberrations (3次収差) =====
  "TOT3_SPH": {
    name: "3rd Order Spherical",
    description: "3rd-order spherical aberration",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_COMA": {
    name: "3rd Order Coma",
    description: "3rd-order coma aberration",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_ASTI": {
    name: "3rd Order Astigmatism",
    description: "3rd-order astigmatism",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_FCUR": {
    name: "3rd Order Field Curvature",
    description: "3rd-order field curvature",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_DIST": {
    name: "3rd Order Distortion",
    description: "3rd-order distortion",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nλ: Source row.\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto)."
  },
  "TOT3_PETZ": {
    name: "Petzval Sum",
    description: "Petzval radius (image surface curvature)",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row" },
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Petzval sum P = Σ(φ/n) across all surfaces in the optical system.\n\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Used for afocal normalization (0=Auto).\n\nUnit: diopters (1/mm)."
  },
  "TOT_LCA": {
    name: "Longitudinal Chromatic",
    description: "Longitudinal chromatic aberration",
    parameters: [
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nUses System Data wavelength settings (no λ parameter).\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto).\n\nNote: これは 3rd-order の longitudinal chromatic coefficient です。値がほぼ 0 でも、オフ軸の lateral/magnification chromatic は残り得ます。倍率色収差を抑えたい場合は TOT_TCA か Lateral Chromatic Aberration 解析を併用してください。"
  },
  "TOT_TCA": {
    name: "Transverse Chromatic",
    description: "Transverse chromatic aberration",
    parameters: [
      { key: "param2", label: "Mode", description: "0=Imaging, 1=Afocal" },
      { key: "param3", label: "Scope", description: "blank/0/ALL=Total, or surface id, blockId, ZG:A" },
      { key: "param4", label: "Ref FL", description: "Reference Focal Length (0=Auto)" }
    ],
    notes: "Signed coefficient value.\n\nUses System Data wavelength settings (no λ parameter).\nMode: 0=Imaging, 1=Afocal.\nScope: EFL の Blocks と同じく自由入力で指定します。blank / 0 / ALL は全系、surface id はその面、blockId はそのブロック、ZG:A のように書くと Zoom Group を評価します。\nReference Focal Length: Normalization scale used for coefficient calculations (0=Auto).\n\nNote: オフ軸の lateral / magnification chromatic を merit で直接抑えるなら、TOT_LCA よりこちらの方が対応づけやすいです。"
  },
  
  // ===== Analysis (解析関連) =====
  "SPOT_SIZE_ANNULAR": {
    name: "Spot Size Annular (µm)",
    description: "Spot size (µm) using Spot Diagram-equivalent sampling, forced to Annular.",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based, blank=Primary)" },
      { key: "param2", label: "Object idx", description: "Object row (1-based, default 1)" },
      { key: "param3", label: "Metric", description: "'rms' or 'dia' (default 'rms')" },
      { key: "param4", label: "Rays", description: "Ray count (default 101)" },
      { key: "param5", label: "Surface", description: "Target surface (1-based, blank=Image)" }
    ],
    notes: "Spot Diagram と同じ生成経路（eva-spot-diagram.generateSpotDiagram）を使ってスポット点群を生成し、主光線基準でRMS/直径を計算します。\n\nRay pattern は Annular に固定します。Annular ring count は固定で 10。\n\nMetric: 'rms' または 'dia'（入力ゆれ許容: RMS/RMSTotal/R, Dia/Diam/D, Diameter）。\n定義: dia(diameter)=2*max(radius), rms=sqrt(mean(x^2)+mean(y^2))。単位µm。\n\nparam5: Surface番号（1-based）を指定すると、そのSurfaceでSpot Sizeを計算します。空欄の場合はImage面を使用します。"
  },
  "SPOT_SIZE_RECT": {
    name: "Spot Size Rectangle (µm)",
    description: "Spot size (µm) using Spot Diagram-equivalent sampling, forced to Rectangle/Grid.",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based, blank=Primary)" },
      { key: "param2", label: "Object idx", description: "Object row (1-based, default 1)" },
      { key: "param3", label: "Metric", description: "'rms' or 'dia' (default 'rms')" },
      { key: "param4", label: "Rays", description: "Ray count (default 501)" },
      { key: "param5", label: "Surface", description: "Target surface (1-based, blank=Image)" }
    ],
    notes: "Spot Diagram と同じ生成経路（eva-spot-diagram.generateSpotDiagram）を使ってスポット点群を生成し、主光線基準でRMS/直径を計算します。\n\nRay pattern は Rectangle(Grid) に固定します。\n\nMetric: 'rms' または 'dia'（入力ゆれ許容: RMS/RMSTotal/R, Dia/Diam/D, Diameter）。\n定義: dia(diameter)=2*max(radius), rms=sqrt(mean(x^2)+mean(y^2))。単位µm。\n\nparam5: Surface番号（1-based）を指定すると、そのSurfaceでSpot Sizeを計算します。空欄の場合はImage面を使用します。"
  },
  "LA_RMS_UM": {
    name: "Spherical Aberration RMS (µm)",
    description: "RMS of longitudinal aberration across pupil (µm), computed from the Spherical Aberration Diagram (meridional only).",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based) or wavelength in µm (blank=Primary)" }
    ],
    notes: "球面収差図（Spherical Aberration Diagram）のメリジオナル光線データから縦収差を集約してRMSを返します。\n\n定義（Option B）:\n- 縦収差 L(r) は図のX軸と同じ（最終面からの焦点位置までの距離, mm）\n- pupil coordinate r は正規化瞳座標（0..1）\n- 面積重み 2r dr で平均 L̄ を計算し、RMS = sqrt(E[(L-L̄)^2])\n- 返り値は µm（= mm * 1000）\n\nパラメータ: λ idx のみ（Sourceテーブル行番号, 1始まり）。空欄/0はPrimary Wavelength。\n\n注: 現状は meridional のみ（片側）で評価します。"
  },
  "SA": {
    name: "Spherical Aberration (LSA, µm)",
    description: "Longitudinal spherical aberration from real rays (meridional), independent from 3rd-order Seidel SA.",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based) or wavelength in µm (blank=Primary)" }
    ],
    notes: "実光線ベースの縦球面収差（LSA）を返します。\n\n定義:\n- 球面収差図（meridional）の縦収差データを使用\n- paraxial 側（最小 pupil coordinate）と marginal 側（最大 pupil coordinate）の差分 |L_marginal - L_paraxial|\n- 単位は µm（mm × 1000）\n\nこれは Seidel 3次係数（TOT3_SPH）とは別の評価量です。"
  },
  "TA_RMS_UM": {
    name: "Transevers Aberration RMS (µm)",
    description: "Transevers Aberration RMS",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based, blank=Primary)" },
      { key: "param2", label: "Object idx", description: "Object row (1-based, default 1)" },
      { key: "param3", label: "Component", description: "total | meridional | sagittal (default total)" },
      { key: "param4", label: "Raynum", description: "Ray count (default 51, odd recommended)" }
    ],
    notes: "横収差図（Transverse Aberration）を内部計算し、指定 Source/Object の評価で RMS を返します。\n\n定義:\n- 評価面: Image面\n- Component=total: meridional + sagittal の transverseAberration を合算して RMS = sqrt(mean(T^2))\n- Component=meridional: メリジオナルのみで RMS\n- Component=sagittal: サジタルのみで RMS\n- 単位: µm（計算値 mm を ×1000）"
  },
  "CRA_DEG": {
    name: "Chief Ray Angle (deg)",
    description: "Absolute chief ray angle at the image surface relative to the global optical axis (Z).",
    parameters: [
      { key: "param1", label: "Object idx/id", description: "Object row selector for the target field (blank=1st object)" },
      { key: "param2", label: "λ idx", description: "Source row (1-based) or wavelength in µm (blank=Primary)" }
    ],
    notes: "実光線追跡で、絞り中心を通る主光線を求めて像面まで追跡します。\n\n返り値:\n- 像面到達時の主光線方向と光軸 Z のなす角の絶対値\n- 単位: deg\n\nparam1 は評価対象の Object 行です。数値 index に加えて object id 文字列も受け付けます。\nparam2 は任意の波長指定です。空欄なら Primary wavelength を使います。"
  },
  "OPD_RMS_WAVES": {
    name: "Wavefront RMS OPD (waves)",
    description: "RMS wavefront aberration based on OPD",
    parameters: [
      { key: "param1", label: "λ idx", description: "Source row (1-based, blank=Primary)" },
      { key: "param2", label: "Object idx", description: "Object row (1-based, default 1)" },
      { key: "param3", label: "Sampling", description: "OPD sampling grid (default 32)" }
    ],
    notes: "Rust/WASM OPDマップ（runNativeOpdMap）を優先して使用し、波面収差のRMSを返します。\n\n定義:\n- OPDサンプル: 瞳内の有限値のみ\n- RMS(OPD): sqrt(mean((OPD - mean(OPD))^2))\n- 単位: waves（波長単位）\n\nSamplingはOPDサンプリングのグリッドサイズ（32, 64, 128, 256, 512）。"
  },
  "ZERN_COEFF": {
    name: "Zernike Coefficient (Noll)",
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
  
  // ===== Other Operands (未実装/非表示) =====
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
      { key: "param1", label: "Element" },
      { key: "param2", label: "Height" },
      { key: "param3", label: "Direction", description: "X/Y/blank=Radial" }
    ],
    notes: "Controls edge thickness at specified height. Select lens element (Lens, Doublet, Triplet). Supports toric surfaces with X/Y direction. For spherical/aspheric, leave Direction blank for radial calculation. Unit: mm."
  },
  "CTCT": {
    name: "CTCT",
    description: "Center Thickness",
    parameters: [
      { key: "param1", label: "Element/Gap" }
    ],
    notes: "Evaluates center thickness of the specified lens element or gap. Select from Lens, Doublet, Triplet, or Gap. Unit: mm."
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
  },
  "RADI": {
    name: "Radius",
    description: "Surface Radius",
    parameters: [
      { key: "param1", label: "Surface" }
    ],
    notes: "Returns the absolute radius of the selected surface in mm. Use the requirement operator and target to constrain minimum or maximum radius. INF/flat surfaces evaluate as FAIL."
  },
  "RADI_ALL": {
    name: "All Radius",
    description: "All Surface Radius",
    parameters: [
      { key: "param1", label: "Mode", description: "MIN or MAX" }
    ],
    notes: "Evaluates all real optical surface radii together. Mode=MIN returns the smallest finite absolute radius, so use `>= target` to constrain every surface from below. Mode=MAX returns the largest absolute radius, so use `<= target` to constrain every surface from above. Flat/INF surfaces cause MAX to evaluate as FAIL."
  },
  "SDIST": {
    name: "SDIST",
    description: "Surface distance",
    parameters: [
      { key: "param1", label: "Surface A" },
      { key: "param2", label: "Surface B" }
    ],
    notes: "Returns the signed axial surface distance in mm from Surface A to Surface B by summing finite thickness values from Surface A through the row immediately before Surface B. Object/Image/coordinate rows are ignored. Surface A and Surface B must resolve to real optical surfaces, and A must be before B. Otherwise evaluates as FAIL."
  },
  "GAP": {
    name: "GAP",
    description: "All Gap Thickness",
    parameters: [
      { key: "param1", label: "Mode", description: "MIN or MAX" }
    ],
    notes: "Evaluates all Gap/AirGap thicknesses together. Mode=MIN returns the smallest finite gap thickness, so use `>= target` to constrain all gaps from below. Mode=MAX returns the largest finite gap thickness, so use `<= target` to constrain all gaps from above."
  },
  "THIC": {
    name: "THIC",
    description: "All Thickness",
    parameters: [
      { key: "param1", label: "Mode", description: "MIN or MAX" }
    ],
    notes: "Evaluates all finite thickness values together, excluding Object thickness and Gap/AirGap thickness. Mode=MIN returns the smallest finite thickness, and Mode=MAX returns the largest finite thickness. Use `>= target` for lower bounds and `<= target` for upper bounds. INF/Infinity entries are ignored."
  },
  "REQMATH": {
    name: "REQMATH",
    description: "Requirement Current Arithmetic",
    parameters: [
      { key: "param1", label: "Left Req", description: "Referenced requirement row id" },
      { key: "param2", label: "Op", description: "+ - * /" },
      { key: "param3", label: "Right Req", description: "Referenced requirement row id" }
    ],
    notes: "Calculates arithmetic from two existing requirement current values. References are by requirement row id. For safety, REQMATH can only read rows that have already been evaluated above the current row in the same evaluation pass. Self-reference, future-row reference, unresolved reference, or division by zero evaluate as FAIL."
  },
  "GMIN": {
    name: "GMIN",
    description: "Minimum Gap Thickness",
    parameters: [],
    notes: "Returns the minimum finite thickness among all Gap/AirGap entries in mm. Use `>= target` to require every gap to stay above the target thickness. If no finite gaps exist, evaluates as FAIL."
  },
  "GMAX": {
    name: "GMAX",
    description: "Maximum Gap Thickness",
    parameters: [],
    notes: "Returns the maximum finite thickness among all Gap/AirGap entries in mm. Use `<= target` to require every gap to stay below the target thickness. If no finite gaps exist, evaluates as FAIL."
  }
};

// Only expose operands that are implemented and intended for the UI.
// Keep other definitions for backward compatibility / future work, but hide them from dropdowns.
const VISIBLE_OPERANDS_IN_UI = new Set([
  'FL', 'EFL', 'PP1', 'PP2', 'BFL', 'IMD', 'OBJD', 'TSL',
  'BEXP', 'EXPD', 'EXPP',
  'ENPD', 'ENPP', 'ENPM',
  'PMAG',
  'FNO_OBJ', 'FNO_IMG', 'FNO_WRK',
  'NA_OBJ', 'NA_IMG',
  'EFFL',
  'TOT3_SPH', 'TOT3_COMA', 'TOT3_ASTI', 'TOT3_FCUR', 'TOT3_DIST', 'TOT3_PETZ',
  'TOT_LCA', 'TOT_TCA',
  'SPOT_SIZE_ANNULAR', 'SPOT_SIZE_RECT',
  'LA_RMS_UM', 'SA', 'TA_RMS_UM', 'CRA_DEG', 'OPD_RMS_WAVES',
  'ZERN_COEFF',
  'EDGE', 'CTCT', 'DBLT_K', 'RADI', 'RADI_ALL', 'SDIST', 'GAP', 'THIC', 'REQMATH'
]);

/**
 * Inspector Display Manager
 * Handles the rendering and updating of the operand inspector panel
 */
export class InspectorManager {
  inspectorElement: HTMLElement | null;
  contentElement: HTMLElement | null;

  constructor(inspectorElementId = 'operand-inspector', contentElementId = 'inspector-content') {
    this.inspectorElement = document.getElementById(inspectorElementId);
    this.contentElement = document.getElementById(contentElementId);
    
    if (!this.inspectorElement || !this.contentElement) {
      console.warn('Inspector elements not found in DOM');
    }
  }
  
  /**
   * Show inspector with operand data
   * @param data - Row data from Tabulator
   */
  show(data: any): void {
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
    definition.parameters.forEach((param: any) => {
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
    try {
      this._installPrincipalPointZoomGroupPickerIfNeeded(data);
    } catch (_) {}
  }

  _installEflBlockPickerIfNeeded(data: any): void {
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
          if (tRaw === 'ObjectSurface' || tRaw === 'ImageSurface') {
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
        ? blocks.map((b: any) => String(b?.blockId ?? '').trim()).filter(Boolean)
        : selRaw.split(/[,\s]+/).map(s => String(s).trim()).filter(Boolean)
    );

    const listId = `coopt-efl-block-picker-${String(rowId)}`;
    const allId = `${listId}-all`;

    const blockItems = blocks
      .map((b: any, idx: number) => {
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

    const allChecked = selectedIds.size >= blocks.filter((b: any) => String(b?.blockId ?? '').trim()).length;

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

    const root = this.contentElement!.querySelector(`#${CSS.escape(listId)}`);
    if (!root) return;

    const setParam2 = (nextVal: string) => {
      try {
        const sre = w.systemRequirementsEditor;
        if (!sre || !sre.table || typeof sre.table.updateData !== 'function') return;
        sre.table.updateData([{ id: rowId, param2: nextVal }]);
        if (typeof sre.saveToStorage === 'function') sre.saveToStorage();
        if (typeof sre.scheduleEvaluateAndUpdate === 'function') sre.scheduleEvaluateAndUpdate();
      } catch (_) {}
    };

    const computeSelection = (): string => {
      const checked = Array.from(root.querySelectorAll('input[type="checkbox"][data-block-id]'))
        .filter((el): el is HTMLInputElement => el && (el as HTMLInputElement).checked)
        .map(el => String(el.getAttribute('data-block-id') || '').trim())
        .filter(Boolean);

      // If none selected, treat as ALL (full system) to avoid empty/ambiguous state.
      if (checked.length === 0) return 'ALL';

      const allIds = blocks.map((b: any) => String(b?.blockId ?? '').trim()).filter(Boolean);
      const allSelected = checked.length >= allIds.length;
      return allSelected ? 'ALL' : checked.join(',');
    };

    const allBox = root.querySelector(`#${CSS.escape(allId)}`) as HTMLInputElement | null;
    if (allBox) {
      allBox.addEventListener('change', () => {
        const wantAll = !!allBox.checked;
        for (const el of root.querySelectorAll('input[type="checkbox"][data-block-id]')) {
          (el as HTMLInputElement).checked = wantAll;
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

  _appendInspectorHtml(fragmentHtml: string): void {
    if (!this.contentElement) return;
    const div = document.createElement('div');
    div.innerHTML = String(fragmentHtml || '');
    while (div.firstChild) {
      this.contentElement.appendChild(div.firstChild);
    }
  }

  _installPrincipalPointZoomGroupPickerIfNeeded(data: any): void {
    const operandType = data?.operand;
    if (operandType !== 'PP1' && operandType !== 'PP2') return;

    const rowId = data?.id;
    if (rowId === undefined || rowId === null) return;

    const blocks = this._getBlocksForConfigHint(data?.configId);
    if (!Array.isArray(blocks) || blocks.length === 0) return;

    const zoomGroups = Array.from(new Set(
      blocks
        .map((b: any) => String(b?.parameters?.zoomGroup ?? '').trim())
        .filter(Boolean)
    ));
    if (zoomGroups.length === 0) return;

    const modeRaw = String(data?.param4 ?? '').trim().toUpperCase();
    const currentGroup = modeRaw === 'ZG' ? String(data?.param2 ?? '').trim() : '';
    const selectId = `coopt-pp-zoom-group-${String(rowId)}`;

    const options = [
      `<option value="">Use S1 / S2</option>`,
      ...zoomGroups.map((group) => {
        const selected = currentGroup === group ? 'selected' : '';
        return `<option value="${group}" ${selected}>${group}</option>`;
      })
    ].join('');

    this._appendInspectorHtml(`
      <div class="inspector-row">
        <strong>Zoom Group:</strong>
        <div style="margin-top:6px;">
          <select id="${selectId}" style="min-width:180px; padding:4px 6px;">
            ${options}
          </select>
          <div style="margin-top:6px; color:#666; font-size:12px;">Selecting a zoom group writes group name to param2 and sets param4=ZG. "Use S1 / S2" switches back to surface-range input.</div>
        </div>
      </div>
    `);

    const select = this.contentElement?.querySelector(`#${CSS.escape(selectId)}`) as HTMLSelectElement | null;
    if (!select) return;

    select.addEventListener('change', () => {
      try {
        const sre = w.systemRequirementsEditor;
        if (!sre || !sre.table || typeof sre.table.updateData !== 'function') return;
        const selected = String(select.value ?? '').trim();
        if (selected) {
          sre.table.updateData([{ id: rowId, param2: selected, param3: '', param4: 'ZG' }]);
        } else {
          sre.table.updateData([{ id: rowId, param2: '', param3: '', param4: '' }]);
        }
        if (typeof sre.saveToStorage === 'function') sre.saveToStorage();
        if (typeof sre.scheduleEvaluateAndUpdate === 'function') sre.scheduleEvaluateAndUpdate();
      } catch (_) {}
    });
  }

  _getBlocksForConfigHint(configIdHint: any): any[] {
    try {
      let sys = null;
      try {
        if (typeof w.loadSystemConfigurationsFromTableConfig === 'function') {
          sys = w.loadSystemConfigurationsFromTableConfig();
        } else if (typeof w.ConfigurationManager !== 'undefined' && typeof w.ConfigurationManager.loadSystemConfigurations === 'function') {
          sys = w.ConfigurationManager.loadSystemConfigurations();
        } else if (typeof w.loadSystemConfigurations === 'function') {
          sys = w.loadSystemConfigurations();
        }
      } catch (_) {
        sys = null;
      }
      if (!sys) {
        sys = tryLoadSystemConfigurations();
      }
      const configs = Array.isArray(sys?.configurations) ? sys.configurations : [];
      const activeId = (sys?.activeConfigId !== undefined && sys?.activeConfigId !== null) ? String(sys.activeConfigId) : '';

      const hintRaw = (configIdHint === undefined || configIdHint === null) ? '' : String(configIdHint).trim();
      let cfg = null;

      if (hintRaw) {
        cfg = configs.find((c: any) => c && String(c.id) === hintRaw) || configs.find((c: any) => c && String(c.name).trim() === hintRaw) || null;
      }
      if (!cfg && activeId) {
        cfg = configs.find((c: any) => c && String(c.id) === activeId) || null;
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
  hide(): void {
    if (this.inspectorElement) {
      this.inspectorElement.style.display = 'none';
    }
  }
  
  /**
   * Update inspector with new data
   * @param data - Updated row data
   */
  update(data: any): void {
    if (this.inspectorElement && this.inspectorElement.style.display === 'block') {
      this.show(data);
    }
  }
  
  /**
   * Get list of available operand types
   * @returns Array of operand type names
   */
  static getAvailableOperands(): string[] {
    return Object.keys(OPERAND_DEFINITIONS).filter((k) => VISIBLE_OPERANDS_IN_UI.has(k));
  }
  
  /**
   * Get definition for specific operand type
   * @param operandType - Operand type name
   * @returns Operand definition or null if not found
   */
  static getOperandDefinition(operandType: string): any | null {
    return OPERAND_DEFINITIONS[operandType] || null;
  }
  
  /**
   * Add new operand definition dynamically
   * @param type - Operand type name
   * @param definition - Operand definition object
   */
  static addOperandDefinition(type: string, definition: any): boolean {
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
   * @param operandType - Operand type name
   * @param data - Row data to validate
   * @returns Validation result with isValid and errors
   */
  static validateOperandData(operandType: string, data: any): { isValid: boolean; errors: string[] } {
    const definition = OPERAND_DEFINITIONS[operandType];
    
    if (!definition) {
      return {
        isValid: false,
        errors: [`Unknown operand type: ${operandType}`]
      };
    }
    
    const errors: string[] = [];
    
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
  w.InspectorManager = InspectorManager;
  w.OPERAND_DEFINITIONS = OPERAND_DEFINITIONS;
}

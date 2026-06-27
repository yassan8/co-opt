# Astigmatic Field Curves - Theory and Implementation

## 理論背景 (Theoretical Background)

### 非点収差とは (What is Astigmatism?)

非点収差（Astigmatism）は、光学系の3次収差の一つで、光軸外の物体点に対して発生する収差です。子午面（Meridional/Tangential Plane）と球欠面（Sagittal Plane）で異なる焦点位置を持つことが特徴です。

### 定義 (Definitions)

#### 1. 子午面（Meridional/Tangential Plane）
- 物体点と光軸を含む平面
- YZ平面（垂直断面）
- この面内を伝搬する光線を**子午光線（Meridional/Tangential Rays）**と呼ぶ

#### 2. 球欠面（Sagittal Plane）
- 子午面に直交し、主光線を含む平面
- XZ平面（水平断面）
- この面内を伝搬する光線を**球欠光線（Sagittal Rays）**と呼ぶ

#### 3. 主光線（Chief Ray）
- 物体点から瞳の中心を通る光線
- 非点収差の評価基準となる

### 非点収差曲線（Astigmatic Field Curves）

非点収差曲線は以下をプロットしたものです：

**横軸（X-axis）**: 像面位置（Image Position, mm）
- 近軸像面からのずれ量
- 正の値：近軸像面より後方（遠い）
- 負の値：近軸像面より前方（近い）

**縦軸（Y-axis）**: 画角（Field Angle, degrees）または像高（Image Height, mm）

**2本の曲線**:
1. **M曲線（Meridional/Tangential）**: 子午面の最良焦点位置（破線）
2. **S曲線（Sagittal）**: 球欠面の最良焦点位置（実線）

## 計算方法 (Calculation Method)

### 実光線追跡法（Real Ray Tracing Method）

従来の3次収差理論による計算ではなく、実光線追跡による数値計算を行います。これにより高次収差も含めた正確な評価が可能です。

### アルゴリズム

各画角について以下を実行：

#### Step 1: 主光線の追跡
```
chiefRay = traceChiefRay(fieldAngle, wavelength)
```
- 物体点から絞り中心を通る主光線を計算
- 主光線の像面交点位置を取得

#### Step 2: 子午面光線ファンの生成
```
meridionalFan = generateRayFan(
    direction: "vertical" (Y方向),
    rays: [upper_marginal, chief, lower_marginal],
    pupilSampling: "linear" or "grid"
)
```
- 瞳上で上下方向（Y軸方向）に配置された光線群
- 主光線 + 上下マージナル光線

#### Step 3: 球欠面光線ファンの生成
```
sagittalFan = generateRayFan(
    direction: "horizontal" (X方向),
    rays: [left_marginal, chief, right_marginal],
    pupilSampling: "linear" or "grid"
)
```
- 瞳上で左右方向（X軸方向）に配置された光線群
- 主光線 + 左右マージナル光線

#### Step 4: 最良焦点位置の探索（Meridional）
```
for each z_position near paraxial_focus:
    spots = []
    for each ray in meridionalFan:
        intersection = ray.intersect(plane_at_z)
        spots.append(intersection.x, intersection.y)
    
    rms = calculateRMS(spots, chief_ray_position)
    
    if rms < min_rms:
        min_rms = rms
        best_focus_z = z_position
```

#### Step 5: 最良焦点位置の探索（Sagittal）
```
for each z_position near paraxial_focus:
    spots = []
    for each ray in sagittalFan:
        intersection = ray.intersect(plane_at_z)
        spots.append(intersection.x, intersection.y)
    
    rms = calculateRMS(spots, chief_ray_position)
    
    if rms < min_rms:
        min_rms = rms
        best_focus_z = z_position
```

#### Step 6: 近軸像点からの差分計算
```
paraxial_z = calculateParaxialFocus(wavelength)
meridional_deviation = best_focus_z_meridional - paraxial_z
sagittal_deviation = best_focus_z_sagittal - paraxial_z
```

### RMS計算式

横収差RMS（Transverse Aberration RMS）:
```
RMS = sqrt( Σ[(xi - x_chief)² + (yi - y_chief)²] / N )
```

ここで：
- (xi, yi): i番目の光線の像面交点座標
- (x_chief, y_chief): 主光線の像面交点座標
- N: 光線本数

### 主光線定義のオプション

実装では3つの主光線定義をサポート：

1. **Stop Center（絞り中央通過）**: 従来定義
   - 絞り中心を通る光線
   
2. **Beam Center（光束巾の真ん中）**: 
   - 像面上での光束のX範囲、Y範囲の中点
   ```
   x_center = (x_max + x_min) / 2
   y_center = (y_max + y_min) / 2
   ```

3. **Centroid（光束の重心）**:
   - 全光線の平均位置
   ```
   x_centroid = Σxi / N
   y_centroid = Σyi / N
   ```

## 実装の特徴

### 現在の実装（astigmatism.ts）

1. **Draw Cross Ray方式**:
   - 十字配置の光線（上下左右4本 + 主光線）を直接追跡
   - メリディオナル：上下マージナル光線 + 主光線
   - サジタル：左右マージナル光線 + 主光線

2. **RMSベースの最良焦点探索**:
   - 像面をz方向に走査
   - 各位置で横収差RMSを計算
   - RMS最小位置を最良焦点として採用

3. **無限系対応**:
   - 無限遠物体からの光線追跡
   - 方向ベクトルの正規化処理
   - 絞り位置の自動検出

4. **主波長基準**:
   - 各波長の結果を主波長（d線: 587.6nm）の軸上焦点位置を基準として表示
   - 色収差の影響を可視化

## 参考文献

1. Wikipedia: "Astigmatism (optical systems)"
   - https://en.wikipedia.org/wiki/Astigmatism_(optical_systems)
   
2. Greivenkamp, John E. (2004). "Field Guide to Geometrical Optics"
   - SPIE Field Guides vol. FG01
   
3. Hecht, Eugene (1987). "Optics" (2nd ed.)
   - Addison Wesley
   
4. Zemax OpticStudio Help: "Field Curvature and Astigmatism"

## 実装日時

- 初版作成: 2025/01/XX
- Draw Cross方式への変更: 2025/11/14
- 主光線モード追加: 2026/02/11
- 理論ドキュメント作成: 2026/02/11

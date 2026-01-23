# 光線追跡アルゴリズム仕様書 (ray-tracing.js)

## 概要
本仕様書では、`ray-tracing.js`で実装された光線追跡アルゴリズムについて、数式を交えて詳細に解説します。各関数の役割、相関関係、入出力仕様を明確に示します。

## 基本数学的定義

### ベクトル演算
```javascript
// 3次元ベクトルの基本演算
vec3(x, y, z)         // ベクトル生成
add(v1, v2)           // v1 + v2
sub(v1, v2)           // v1 - v2  
scale(v, s)           // s * v
dot(v1, v2)           // v1 · v2 = v1.x*v2.x + v1.y*v2.y + v1.z*v2.z
magnitude(v)          // |v| = √(v.x² + v.y² + v.z²)
normalize(v)          // v/|v|
```

### 座標系変換

#### 回転行列（オイラー角）
座標変換1.5.md仕様に基づく4×4回転行列：

```
X軸回転: Rx(θx) = [1    0      0     0]
                   [0  cos(θx) -sin(θx) 0]
                   [0  sin(θx)  cos(θx) 0]
                   [0    0      0     1]

Y軸回転: Ry(θy) = [cos(θy)  0  sin(θy)  0]
                   [0       1    0      0]
                   [-sin(θy) 0  cos(θy)  0]
                   [0       0    0      1]

Z軸回転: Rz(θz) = [cos(θz) -sin(θz)  0  0]
                   [sin(θz)  cos(θz)  0  0]
                   [0        0       1  0]
                   [0        0       0  1]
```

変換順序：
- Order 0: R = Rx · Ry · Rz
- Order 1: R = Rz · Ry · Rx

## 主要アルゴリズム

### 1. 非球面SAG計算（Horner法最適化）

#### 数式
非球面のZ座標（SAG: Surface sag）は以下で定義：

```
z(r) = cr²/(1 + √(1 - (1+k)c²r²)) + Σ(i=1 to 10) Ai·r^(2i)
```

ここで：
- r = √(x² + y²) : 光軸からの半径距離
- c = 1/R : 曲率（Rは曲率半径）
- k : コーニック定数
- Ai : 非球面係数 (coef1, coef2, ..., coef10)

#### 実装関数
```javascript
function asphericSag(r, params, mode = "even")
```

**入力:**
- `r`: 半径距離 [mm]
- `params`: {radius, conic, coef1-coef10, semidia}
- `mode`: "even" (偶数べき) または "odd" (奇数べき)

**出力:**
- SAG値 [mm]

**最適化:**
- Horner法使用でMath.pow()を排除
- 段階的乗算: r² → r⁴ → r⁶ → ... で計算効率化

### 2. 非球面法線ベクトル計算

#### 数式
面の法線ベクトルは微分を用いて計算：

```
∂z/∂x = (∂z/∂r) · (∂r/∂x) = (∂z/∂r) · (x/r)
∂z/∂y = (∂z/∂r) · (∂r/∂y) = (∂z/∂r) · (y/r)

法線ベクトル: n = (-∂z/∂x, -∂z/∂y, 1)
正規化: n̂ = n/|n|
```

#### SAGの解析的微分（dz/dr）

**球面部分:**
```
d/dr[cr²/(1 + √(1 - (1+k)c²r²))] = 複雑な解析式（商の微分公式）
```

**非球面部分:**
```
d/dr[Σ Ai·r^(2i)] = Σ 2i·Ai·r^(2i-1)
```

#### 実装関数
```javascript
function asphericSagDerivative(r, params, mode)
function surfaceNormal(pt, params, mode)
```

**高速化:**
数値微分（6回のSAG計算）→ 解析的微分（1回の微分計算）で3-5倍高速化

### 3. 面との交点計算

#### 球面・非球面統一アルゴリズム
Newton-Raphson法による数値解法：

```
F(t) = z(rayPos + t·rayDir) - asphericSag(r) = 0
```

#### Newton法の更新式
```
t(n+1) = t(n) - F(t(n))/F'(t(n))

F'(t) = rayDir.z - (∂z/∂r)·(rayPos.x·rayDir.x + rayPos.y·rayDir.y)/r
```

#### 実装関数
```javascript
function intersectAsphericSurface(ray, params, mode, maxIter, tol, debugLog)
```

**入力:**
- `ray`: {pos: {x,y,z}, dir: {x,y,z}}
- `params`: 面パラメータ
- `maxIter`: 最大反復回数（デフォルト20）
- `tol`: 収束判定閾値（デフォルト1e-7）

**出力:**
- 交点座標 {x,y,z} または null（交点なし）

**初期推定値戦略:**
1. 球面近似解（2次方程式）
2. 平面近似解
3. セミ径ベース推定値
4. フォールバック値群

### 4. スネルの法則による屈折

#### 数式
入射光線dir、法線normal、屈折率n1→n2での屈折光線：

```
cos(θi) = -normal · dir
η = n1/n2
k = 1 - η²(1 - cos²(θi))

屈折光線 = η·dir + (η·cos(θi) - √k)·normal
```

全反射条件：k < 0

#### 実装関数
```javascript
function refractRay(dir, normal, n1, n2)
```

### 5. 座標変換処理（Coordinate Break面）

#### CB面パラメータマッピング
```
semidia  → decenterX
material → decenterY (CB面専用)
thickness → decenterZ
rindex   → tiltX [度]
abbe     → tiltY [度]
conic    → tiltZ [度]
coef1    → transformOrder (0 or 1)
```

#### 変換順序
**Order 0: Decenter → Tilt**
```
光線追跡時（逆変換）: Tilt⁻¹ → Decenter⁻¹
```

**Order 1: Tilt → Decenter**
```
光線追跡時（逆変換）: Decenter⁻¹ → Tilt⁻¹
```

#### 実装関数
```javascript
function createCoordinateTransform(row, rotationCenterZ)
function applyCoordinateTransform(ray, transform, debugLog)
function applyInverseCoordinateTransform(ray, transform, debugLog)
```

## メイン光線追跡アルゴリズム

### 全体処理フロー
```javascript
function traceRay(opticalSystemRows, ray0, n0, debugLog, maxSurfaceIndex)
```

#### 処理手順
1. **初期化**
   - 光線の深いコピー作成
   - 各面の原点O(s)・回転行列R(s)計算
   - rayPath配列初期化

2. **面ごとの処理ループ**
   ```
   for each surface i:
     if (Coordinate Break面):
       座標系変換のみ
     else if (Object面):
       thickness分前進のみ
     else:
       a) ローカル座標変換
       b) 面との交点計算
       c) 開口制限チェック
       d) 反射・屈折計算
       e) thickness分前進
   ```

3. **座標系変換**
   - グローバル→ローカル: P_local = R⁻¹(P_global - O)
   - ローカル→グローバル: P_global = R·P_local + O

4. **開口制限処理**
   - Semi Diameter制限
   - 実絞り面（STO）のaperture制限
   - 物理的遮蔽による光線停止

### 面の原点・回転行列計算

#### 数式（座標変換1.5.md準拠）
```javascript
function calculateSurfaceOrigins(opticalSystemRows)
```

**通常面:**
```
O(s) = O(s-1) + t(s-1) · R(s-1) · ez
R(s) = R(s-1)
```

**CB面:**
```
Order 0: O(s) = O(s-1) + DX·R(s-1)·ex + DY·R(s-1)·ey + t(s-1)·R(s-1)·ez
Order 1: O(s) = O(s-1) + DX·R(s)·ex + DY·R(s)·ey + t(s-1)·R(s-1)·ez
R(s) = R_single(tiltX,tiltY,tiltZ) · R(s-1)
```

ここで：
- ex, ey, ez: 基底ベクトル
- t: thickness [mm]
- DX, DY: decenter [mm]

## パフォーマンス最適化

### 1. Horner法による高速化
```javascript
// 従来（遅い）
sum += coef * Math.pow(r, 2*i)

// 最適化後（2-3倍高速）
r_power *= r2;  // 段階的乗算
sum += coef * r_power;
```

### 2. 解析的微分による高速化
```javascript
// 従来（遅い）: 6回のSAG計算による数値微分
const dzdr = (sag(r+h) - sag(r-h)) / (2*h);

// 最適化後（3-5倍高速）: 1回の解析計算
const dzdr = asphericSagDerivative(r, params, mode);
```

### 3. WASM統合準備
FastMath.jsとの統合により、さらなる高速化が可能。

## 入出力仕様

### メイン関数: traceRay()

**入力:**
- `opticalSystemRows`: 光学系データ配列
- `ray0`: 初期光線 {pos: {x,y,z}, dir: {x,y,z}, wavelength}
- `n0`: 初期屈折率（デフォルト1.0）
- `debugLog`: デバッグ配列（nullの場合は無効）
- `maxSurfaceIndex`: 処理する最大面番号（null=全面）

**出力:**
- `rayPath`: 光線経路点配列 [{x,y,z}, ...] または null（失敗）

### 補助関数群

#### ベクトル関数
- `vec3(x,y,z)` → {x,y,z}
- `add(v1,v2)` → {x,y,z}
- `sub(v1,v2)` → {x,y,z}
- `scale(v,s)` → {x,y,z}
- `dot(v1,v2)` → Number
- `norm(v)` → {x,y,z} (正規化済み)

#### 面計算関数
- `asphericSag(r, params, mode)` → Number [mm]
- `asphericSagDerivative(r, params, mode)` → Number [mm⁻¹]
- `surfaceNormal(pt, params, mode)` → {x,y,z} (正規化済み)
- `intersectAsphericSurface(ray, params, ...)` → {x,y,z} | null

#### 光学関数
- `refractRay(dir, normal, n1, n2)` → {x,y,z} | null
- `reflectRay(dir, normal)` → {x,y,z}

## エラーハンドリング

### 主要なエラーケース
1. **交点計算失敗**: Newton法収束せず → null返却
2. **全反射**: スネルの法則でk<0 → 光線追跡停止
3. **開口制限**: 物理的遮蔽 → null返却（光線停止）
4. **数値エラー**: NaN/Infinity → フォールバック値使用

### デバッグ機能
debugLog配列に詳細ログを出力：
- 各面での光線位置・方向
- 交点計算の収束状況
- 座標変換の詳細
- 開口制限チェック結果

## 物理的制約

### 座標系
- 光軸: Z軸正方向
- 光線進行: Z正方向（通常）
- 面位置: ローカル座標でZ=0

### 単位系
- 長さ: mm
- 角度: 度（内部でラジアン変換）
- 屈折率: 無次元

### 制限事項
- セミ径制限による物理的開口
- 実絞り面でのaperture制限
- 数値計算精度による収束限界

## 関数相関図

```
traceRay()
├── calculateSurfaceOrigins()
│   ├── createRotationMatrix()
│   ├── multiplyMatrices()
│   └── parseCoordBreakParams()
├── intersectAsphericSurface()
│   ├── asphericSag()
│   └── asphericSagDerivative()
├── surfaceNormal()
│   └── asphericSagDerivative()
├── refractRay() / reflectRay()
├── transformRayToLocal() / transformPointToGlobal()
│   ├── applyMatrixToVector()
│   └── invertMatrix()
└── applyCoordinateTransform()
    └── applyInvRotation()
```

## 結論

本ray-tracing.jsは、以下の特徴を持つ高性能光線追跡エンジンです：

1. **数学的精度**: 解析的微分による正確な法線計算
2. **計算効率**: Horner法と段階的乗算による2-5倍高速化
3. **汎用性**: 球面・非球面・平面・CB面対応
4. **拡張性**: WASM統合とモジュラー設計
5. **デバッグ性**: 詳細ログとエラーハンドリング

これにより、複雑な光学系における高精度光線追跡を効率的に実現しています。

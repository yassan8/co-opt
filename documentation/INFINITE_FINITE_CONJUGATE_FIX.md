# 無限系・有限系の判定修正

## 修正日
2026年2月11日

## 問題
非点収差計算において、Object Position Type（物体位置指定方式）に応じた無限系・有限系の判定が正しく行われていませんでした。

- **Object Position Angle**: 無限系（infinite conjugate）として扱うべき → 物体が無限遠にあり、平行光束で入射
- **Rectangle/Height**: 有限系（finite conjugate）として扱うべき → 物体が有限距離にあり、発散光束で入射

## 修正内容

### 1. 判定ロジックの修正

#### Object Position Typeの定義
```typescript
const positionType = (fieldSetting.position || fieldSetting.fieldType || '').toLowerCase();
const isAngleField = positionType.includes('angle') && !positionType.includes('rectangle');
```

**重要**: `rectangle` という文字列には `angle` が含まれるため、単純な `includes('angle')` では誤判定が発生します。

#### 正しい判定
- **無限系**: `positionType.includes('angle') && !positionType.includes('rectangle')`
- **有限系**: `positionType.includes('rectangle') || positionType.includes('height')`

### 2. 修正したファイル

#### `evaluation/aberrations/transverse-aberration.ts`

**generateCrossBeamForField関数** (行340-370):
```typescript
// Object Position Angleは無限系、それ以外（Rectangle/Height）は有限系として扱う
const positionType = (fieldSetting.position || fieldSetting.fieldType || '').toLowerCase();
const isAngleField = positionType.includes('angle') && !positionType.includes('rectangle');
const forceInfiniteByAngle = isAngleField;  // angle指定は無限系として強制
const forceFiniteByRectangle = positionType.includes('rectangle') || positionType.includes('height');

if ((isFinite || forceFiniteByRectangle) && !forceInfiniteByAngle) {
    // 有限系: Object位置を使用（Rectangle/Heightを使用）
    // ... 有限系の処理
} else {
    // 無限系: 画角を使用（Object Position Angle）
    // ... 無限系の処理
}
```

**calculateChiefRayNewton関数** (行2920-2930):
```typescript
// 有限系・無限系の判定
// Object Position Angleは無限系、Rectangle/Heightは有限系として扱う
const positionType = (fieldSetting.position || fieldSetting.fieldType || '').toLowerCase();
const isAngleField = positionType.includes('angle') && !positionType.includes('rectangle');
const isFinite = isAngleField ? false : isFiniteSystem(opticalSystemRows);
```

#### `evaluation/aberrations/astigmatism.ts`

**processFieldForAstigmatism関数** (行1585-1605):
```typescript
// フィールド角を取得
// Object Position Angle: 無限系として画角を使用
// Rectangle/Height: 有限系として物体高さを使用
let fieldAngle;
const positionType = (fieldSetting.position || fieldSetting.fieldType || '').toLowerCase();
const isAngleField = positionType.includes('angle') && !positionType.includes('rectangle');
const fieldType = isAngleField ? 'angle' : 'height';

if (isAngleField) {
    // 無限系: Y方向の角度を使用
    fieldAngle = Math.abs(
        fieldSetting.yFieldAngle || 
        fieldSetting.fieldAngle || 
        fieldSetting.y || 
        fieldSetting.yHeightAngle || 
        0
    );
} else {
    // 有限系: 高さの場合はyHeight値を使用
    fieldAngle = Math.abs(fieldSetting.yHeight || fieldSetting.y || 0);
}
```

**isAngleField判定** (行1350-1360, 行1410):
```typescript
// Object Position Angleは無限系、Rectangle/Heightは有限系
const hasRectangleOrHeight = (fieldSettings || []).some(f => {
    const posType = (f.position || f.fieldType || '').toLowerCase();
    return posType.includes('rectangle') || posType.includes('height');
});
const hasAngleOnly = (fieldSettings || []).some(f => {
    const posType = (f.position || f.fieldType || '').toLowerCase();
    return posType.includes('angle') && !posType.includes('rectangle');
});
const isAngleField = hasRectangleOrHeight ? false : hasAngleOnly;
```

**軸上フィールド検索** (行1433-1446):
```typescript
// 軸上（0°または0mm）フィールドを検索
const axialField = fieldSettings.find(f => {
    const posType = (f.position || f.fieldType || '').toLowerCase();
    const isAngle = posType.includes('angle') && !posType.includes('rectangle');
    
    if (isAngle) {
        // 無限系: 角度が0に近い
        const angle = Math.abs(f.y || 0);
        return angle < 0.001; // ほぼ0°
    } else {
        // 有限系: 高さが0に近い
        const height = Math.abs(f.y || 0);
        return height < 0.001; // ほぼ0mm
    }
});
```

#### `evaluation/aberrations/astigmatism-plot.ts`

**plotAstigmaticFieldCurves関数** (行310-325):
```typescript
// デフォルトオプション
// Object Position Angleは無限系（角度）、Rectangle/Heightは有限系（物体高）
const fsList = astigmatismData.fieldSettings || [];
const hasRectangleOrHeight = fsList.some(fs => {
    const posType = (fs.position || fs.fieldType || '').toLowerCase();
    return posType.includes('rectangle') || posType.includes('height');
});
const hasAngleOnly = fsList.some(fs => {
    const posType = (fs.position || fs.fieldType || '').toLowerCase();
    return posType.includes('angle') && !posType.includes('rectangle');
});

// Rectangleまたはheightがある場合は有限系（物体高）、angleのみの場合は無限系（角度）
const isAngleField = astigmatismData.isAngleField ?? (hasRectangleOrHeight ? false : hasAngleOnly);
```

### 3. 光学的な意味

#### 無限系（Infinite Conjugate）
- **物体**: 無限遠にある（Object Distance = ∞）
- **入射光束**: 平行光
- **Object Position指定**: Angle（画角、度）
- **用途**: 望遠鏡、コリメータ、天体観測など
- **計算**: `generateInfiniteSystemCrossBeam()` を使用

#### 有限系（Finite Conjugate）
- **物体**: 有限距離にある（Object Distance = 有限値）
- **入射光束**: 発散光
- **Object Position指定**: Rectangle/Height（物体高さ、mm）
- **用途**: カメラレンズ、顕微鏡、拡大縮小系など
- **計算**: `generateFiniteSystemCrossBeam()` を使用

### 4. プロット表示の変更

#### Y軸ラベル
- **無限系**: `Object Angle θ (deg)` - 画角を度単位で表示
- **有限系**: `Object Height (mm)` - 物体高さをmm単位で表示

#### ホバー情報
- **無限系**: `Object Angle θ: XX.XX deg`
- **有限系**: `Object Height: XX.XX mm`

## 動作確認

### ビルド結果
```
✓ built in 1.43s
```

### 期待される動作
1. **Object Position = Angle** を指定した場合:
   - 無限系として計算される
   - Y軸: `Object Angle θ (deg)`
   - 画角に対する非点収差が表示される

2. **Object Position = Rectangle** を指定した場合:
   - 有限系として計算される
   - Y軸: `Object Height (mm)`
   - 物体高さに対する非点収差が表示される

## 影響範囲

### 影響を受ける機能
- ✅ 非点収差計算（Astigmatism）
- ✅ 横収差計算（Transverse Aberration）
- ✅ 主光線計算（Chief Ray）
- ✅ スポットダイアグラム（Spot Diagram）

### 影響を受けない機能
- MTF計算
- 波面収差計算
- PSF計算
- ゼルニケ係数計算

## 参考資料

### 光学理論
- Warren J. Smith, "Modern Optical Engineering", Chapter 3: Aberrations
- SPIE Field Guide to Geometrical Optics, Section on Conjugates
- Zemax OpticStudio Help: Field Type (Angle vs Object Height)

### 関連コミット
- 2026-02-07 ddca596: Fix direction normalization in aberration tools
- 2026-02-11: Fix infinite/finite conjugate determination for Object Position types

## まとめ

この修正により、Object Position Type（Angle/Rectangle/Height）に応じて、光学系が無限系か有限系かを正しく判定し、適切な光線追跡アルゴリズムを選択するようになりました。

特に重要なのは、`rectangle` という文字列に `angle` が含まれることによる誤判定を防ぐため、`!positionType.includes('rectangle')` という条件を追加したことです。

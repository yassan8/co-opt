# Qcon Ray Tracing デバッグ手順

## 問題の可能性

改善されていない理由として以下が考えられます：

### 1. **Surface Type が 'qcon' に設定されていない**
- Design Inspector で surface type が 'qcon' になっているか確認してください
- 値は大文字小文字を区別しています

### 2. **Qcon 係数がすべてゼロ**
- qconNrad, coef1～coef10 が全て 0 でないか確認
- 0 の場合、表面は球面と同じになります

### 3. **Mode が 'qcon' として Ray Tracing に渡されていない**
- ブラウザの Developer Console で以下を実行:
  ```javascript
  // Design Inspector で surface を選択し、console で実行:
  const surfType = document.querySelector('[data-testid="surfType-value"]')?.textContent;
  console.log('Current surface type:', surfType);
  ```

## 確認方法

### A. Console でパラメータを検査
```javascript
// ブラウザ console で:
// 1. Design Inspector でQcon surface を選択
// 2. 以下を実行してパラメータを確認

// Global state からパラメータを取得（仮）
const currentSystem = window.__cooptState?.getOpticalSystem?.();
const blocks = currentSystem?.blocks || [];
const qconBlock = blocks.find(b => b.surfaces?.some(s => s.surfType?.includes('qcon')));
console.log('Qcon Block:', qconBlock);
```

### B. Ray Tracing Mode を確認
```javascript
// ray-tracing.ts の isQconMode がどうなっているか
// 実際には、debugLog を有効にして追跡:
// raytracing/core/ray-tracing.ts line 1219 付近

// または、ネットワークタブで WASM call を監視
// public/rust-wasm/pkg/surface_origins.js のコールを見て、
// intersect_qcon_surface が呼ばれているか確認
```

## 数式の正確性確認

式そのものは **JS と Rust で同じ**ことを確認済み：

```
Qcon sag: z = z_conic + Σ(coef_i * u^4 * P_i^(0,4)(2u^2-1))
where u = r / scale, scale = qconNrad or semidia

Derivative: dz/dr = base_derivative + Σ(coef_i * (4u^3*P_i + 4u^5*dP_i/dx) / scale)
```

→ 式は正しい

## 次のステップ

1. **Surface type が 'qcon' か確認**
2. **Qcon パラメータが 0 でないか確認**
3. **DI から実際のパラメータ値をコピーして報告**

これらの情報があれば、より的確なデバッグが可能です。

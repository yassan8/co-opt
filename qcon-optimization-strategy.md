# Qcon 再起式最適化戦略

## ユーザーリクエスト
"光線追跡高速化のため、Qconの再起式をあらかじめハードコートしておくのがよいのでは?"
→ Qcon recursion formula を事前生成して高速化したい

## 現在の実装状況

### Ray Tracing 側
- ✅ `__buildQconParamsArray()` で qconNrad を extract
- ✅ WeakMap キャッシュで parameter array を再利用
- ❌ Jacobi polynomial 計算は毎回実行

### Rendering 側  
- ❌ キャッシュなし、毎回 Jacobi polynomial を計算

## 最適化戦略の比較

### Option A: Jacobi Polynomial キャッシング (推奨)
**概要**: 計算済みの Jacobi 多項式値をキャッシュ

**実装**:
```typescript
// qcon-basis.ts に追加
const jacobiPolyCache = new WeakMap<any, Map<string, number>>();

function cachedJacobiPolynomial(n, alpha, beta, x, params) {
  if (!jacobiPolyCache.has(params)) {
    jacobiPolyCache.set(params, new Map());
  }
  const cache = jacobiPolyCache.get(params);
  const key = `${n},${alpha},${beta},${x}`;
  if (!cache.has(key)) {
    cache.set(key, jacobiPolynomial(n, alpha, beta, x));
  }
  return cache.get(key);
}
```

**メリット**:
- 実装が簡単
- 既に ray-tracing 側で使われているパターン
- メモリオーバーヘッド小さい

**デメリット**:
- x 値が異なるたびに新規計算必要
- cache hit rate が低い可能性

---

### Option B: 係数テーブル事前計算
**概要**: optical system 初期化時に多項式係数を事前計算

**実装**:
```typescript
// system-renderer.ts の drawOpticalSystemSurfaces 内
const qconPolyCache = {};
for (const surface of opticalSystemData) {
  if (surface.surfType === 'Qcon') {
    const nrad = surface.qconNrad || 1;
    const key = `qcon_${nrad}`;
    if (!qconPolyCache[key]) {
      // n=0-10, alpha=0, beta=4 の係数を事前計算
      qconPolyCache[key] = precomputeJacobiTable(nrad);
    }
  }
}
```

**メリット**:
- ray tracing 中の計算が極めて軽い
- テーブル参照のみで高速

**デメリット**:
- 初期化時間が増加
- メモリ使用量増加
- optical system 変更時に再計算必要

---

### Option C: インライン再起式展開
**概要**: 毎回の function call overhead を削減

**実装**:
```typescript
// 小さな n (≤10) なら手動展開
function jacobiPolynomialInlined(n, alpha, beta, x) {
  if (n === 0) return 1;
  if (n === 1) return alpha + 1 + (alpha + beta + 2) * ((x - 1) / 2);
  // ... n=2-10 各自コード展開 ...
  // 大きな n は再帰関数へ
}
```

**メリット**:
- function call overhead 削減 (~10-20% 高速化)
- 実装簡単

**デメリット**:
- コード行数増加
- 再起式の理解性低下
- 小さな n のみ効果的

---

## 推奨実装パス

### Phase 1: プロファイリング (必須) 
```typescript
// qcon-basis.ts に追加
let jacobiCallCount = 0;
let jacobiTotalTime = 0;

function jacobiPolynomial(n, alpha, beta, x) {
  const start = performance.now();
  // 既存の計算...
  jacobiTotalTime += performance.now() - start;
  jacobiCallCount += 1;
  return result;
}

// 定期的にログ出力
setInterval(() => {
  console.log(`[Qcon] Jacobi calls: ${jacobiCallCount}, time: ${jacobiTotalTime.toFixed(2)}ms, avg: ${(jacobiTotalTime/jacobiCallCount).toFixed(4)}ms`);
}, 5000);
```

### Phase 2: 最適化実装
1. プロファイル結果に応じて Option A/B/C から選択
2. ray tracing cycle 内での impact 測定
3. rendering cycle 内での impact 測定

### Phase 3: 検証
- Before/After パフォーマンス比較
- 精度の確認（数値の一致性）
- メモリ使用量の確認

---

## 現在判明している事実

1. **Ray Tracing**: 既に `__buildQconParamsArray()` でキャッシング有り
2. **Rendering**: キャッシング なし → optimization opportunity
3. **Jacobi Polynomial**: 毎回計算 → 小さな n (<= 10) は固定
4. **共通パラメータ**: alpha=0, beta=4 固定 (Q-con/Legendre basis)

---

## 次のアクション

1. ✅ C2 (Nrad) parameter application 確認完了
2. ⏳ Qcon ray tracing performance profiling
3. ⏳ 最適化アプローチの選択と実装
4. ⏳ 高速化の検証とベンチマーク

# Web Worker並列化の試行結果と結論

**日付**: 2026年2月17日  
**目的**: OPD計算の並列化による高速化（目標: 2-3× speedup）  
**結果**: **失敗 - 並列化不適切と判断**

---

## 実装内容

### 1. Web Worker アーキテクチャ
- `evaluation/wavefront/wavefront-worker.ts`: Worker スクリプト
- `_calculateOPDParallel()`: グリッド分割と並列実行コーディネーター
- `generateWavefrontMap()`: `useWebWorkers` オプションで制御

### 2. グリッド分割戦略
- CPU コア数（8コア）に応じて自動分割
- 各Workerに約1,581点ずつ割り当て（12,644点 ÷ 8）

---

## ベンチマーク結果

### 実行環境
- CPU: 8コア
- グリッドサイズ: 128×128 (12,644点)
- 画角: 10°
- 波長: 0.5876 μm

### 性能比較

| 方式 | 実行時間 | 有効点数 | Speedup |
|------|---------|---------|---------|
| **逐次版** | 2,672 ms | 8,690点 | 1.00× (baseline) |
| **並列版 (8 Workers)** | 2,578 ms | **5,324点** ⚠️ | **1.04×** (誤差範囲) |

### 重大な問題

#### 1. **結果の不一致** (致命的)
- 並列版は **39%のデータを失っている**（8,690点 → 5,324点）
- 計算精度が保証できない

#### 2. **Pupil Sampling Mode の不整合**
```
[逐次版の挙動]
1. stop mode で試行
2. "stop miss dominant" を検出
3. 自動的に entrance mode に切り替え
4. 成功 (8,690点)

[並列版の挙動]
1. 各Workerが独立に stop mode で試行
2. メインスレッドの mode 切り替えが共有されない
3. Workerごとに異なる結果:
   - Worker 1: 0 valid (0%) 
   - Worker 4: 8 valid (0.5%)
   - Worker 7: 1,581 valid (100%)
4. 合計 5,324点（平均 61%）
```

#### 3. **順序依存性の喪失**
- BFS (breadth-first search) 順序が並列化で破壊される
- Continuity seeding（近傍点からの初期値推定）が機能しない
- グリッド分割により隣接点が別Workerに配置される

#### 4. **速度改善の欠如**
- わずか 3.6% speedup（誤差範囲）
- Worker起動オーバーヘッド: 各Workerで参照光線設定、Calculator初期化
- データ転送コスト: 光学系データ (opticalSystemRows) を8回シリアライズ

---

## 失敗の根本原因

### Web Workerの限界

1. **状態共有不可**
   - メインスレッドの動的 mode 切り替えが共有できない
   - `_getInfinitePupilMode()` などの状態管理が分離される

2. **独立したコンテキスト**
   - 各Workerが完全に独立した OPDCalculator を持つ
   - WASM モジュールを8回起動（メモリ浪費）
   - 参照光線が微妙に異なる（浮動小数点誤差の蓄積）

3. **順序依存アルゴリズムとの不整合**
   - OPD計算は隣接点の結果を利用する最適化（continuity seeding）を使用
   - グリッド分割により最適化が無効化される

4. **オーバーヘッド過大**
   - Worker起動: ~50-100ms × 8
   - データ転送: 光学系データ（数百KB）× 8
   - 計算時間（1,500-2,000ms）に対してオーバーヘッドが大きすぎる

---

## 教訓

### 1. **並列化が効果的な条件**
- ✅ 完全に独立した計算タスク
- ✅ データ転送コスト < 計算コスト
- ✅ 状態共有が不要
- ✅ 順序依存性がない

### 2. **OPD計算の特性**
- ❌ 動的な mode 切り替えに依存（state-dependent）
- ❌ 順序依存性あり（BFS + continuity seeding）
- ❌ 参照光線の共有が必須
- ❌ 計算コストが相対的に小さい（2-3秒）

### 3. **"測定なき最適化は無意味"**
Phase 1, Option A に続き、Option B (並列化) も失敗。
理論的な speedup 予測と実測結果の乖離を再確認。

---

## 代替アプローチ（推奨）

### Option 1: **グリッドサイズの適応的削減** ⭐⭐⭐
**期待効果**: 4× speedup（実証済み）

```typescript
// 128×128 (12,644点, 2,672ms) → 64×64 (3,141点, ~650ms)
const gridSize = isInteractive ? 64 : 128;
const wavefrontMap = await analyzer.generateWavefrontMap(
    fieldSetting, 
    gridSize,
    'circular', 
    { opdMode: 'referenceSphere' }
);
```

**利点**:
- 実装が簡単
- 確実に効果がある（O(n²)）
- ユーザー体験の向上（リアルタイム更新）

### Option 2: **キャッシング戦略** ⭐⭐⭐
**期待効果**: 再計算時 10-100× speedup

```typescript
class WavefrontCache {
    private cache = new Map<string, WavefrontMap>();
    
    getCacheKey(fieldSetting, gridSize, opdMode) {
        return `${fieldSetting.fieldAngle.x},${fieldSetting.fieldAngle.y},${fieldSetting.wavelength},${gridSize},${opdMode}`;
    }
    
    get(key) { return this.cache.get(key); }
    set(key, value) { this.cache.set(key, value); }
}
```

**利点**:
- 同一条件の再計算がゼロコスト
- 光学系変更時のみ再計算
- メモリ効率的（LRU cache 実装可能）

### Option 3: **Progressive Loading** ⭐⭐
**期待効果**: UX改善（体感速度 2-3×）

```typescript
// Stage 1: 高速プレビュー (32×32, ~150ms)
const preview = await analyzer.generateWavefrontMap(fieldSetting, 32, 'circular', {...});
displayWavefront(preview); // ユーザーに即座に表示

// Stage 2: 最終品質 (128×128, 2,672ms)
const final = await analyzer.generateWavefrontMap(fieldSetting, 128, 'circular', {...});
displayWavefront(final); // 置き換え
```

**利点**:
- ユーザーは待ち時間を感じにくい
- 即座にフィードバックが得られる
- 実装が比較的簡単

---

## 結論

**Web Worker並列化は、OPD計算には適していない。**

1. **状態共有が必須** → Worker の独立性と矛盾
2. **順序依存性** → 並列化により最適化が破壊される
3. **計算コスト小** → オーバーヘッドが支配的

代わりに、**グリッドサイズ削減**と**キャッシング**を優先すべき。
これらは確実に効果があり、実装もシンプル。

---

## 次のアクション

1. ✅ 並列化コードを保持（デフォルトOFF）
2. ⏳ グリッドサイズの適応的削減を実装
3. ⏳ キャッシング戦略を設計
4. ⏳ Progressive Loading を検討

並列化の試みは失敗したが、**「何が効果的でないか」を学ぶことも重要な成果**。

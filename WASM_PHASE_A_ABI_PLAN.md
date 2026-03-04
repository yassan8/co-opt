# Phase A: JSONレスWASM ABI 設計書（Optimizer）

最終更新: 2026-03-04
対象: `optimization/optimizer-mvp.ts` と `rust-wasm/src/lib.rs` 間の最適化ホットパス

---

## 1. 目的

現状の `optimize_system_in_wasm(payloadJson)` は、
- JS側: `JSON.stringify(payload)`
- Rust側: `serde_json` で parse
- Rust側: `serde_json::to_string`
- JS側: `JSON.parse`

という往復を1反復ごとに実施しており、ホットループでは無視できない固定コストになります。

**Phase Aの目標**:
1. 反復ホットパスから JSON を排除
2. `number[][]` 変換を削減し、`Float64Array` 一貫処理へ
3. 既存アルゴリズム（FD Jacobian + LM/SQP）を崩さずに高速化

---

## 2. 新ABI（提案）

### 2.1 Rust export（WASM）

```rust
#[wasm_bindgen]
pub fn optimize_one_iter_from_buffers(
    x_ptr: u32,            // f64[n]
    steps_ptr: u32,        // f64[n]
    r0_ptr: u32,           // f64[m]
    r_batches_ptr: u32,    // f64[n*m] (col-major: col*m + row)
    var_scales_ptr: u32,   // f64[n]
    out_dx_ptr: u32,       // f64[n]  (output)
    out_x_next_ptr: u32,   // f64[n]  (output)
    out_meta_ptr: u32,     // f64[8]  (output meta)
    n: u32,
    m: u32,
    damping: f64,
    trust_radius: f64,
) -> u32; // status code
```

### 2.2 status code

- `0`: OK
- `1`: Invalid length / pointer
- `2`: Non-finite input
- `3`: Jacobian build failure
- `4`: Normal equation build failure
- `5`: Linear solve failure
- `6`: Unknown internal error

### 2.3 out_meta_ptr（f64[8]）定義

- `[0]`: predicted_reduction
- `[1]`: used_damping
- `[2]`: used_trust_radius
- `[3]`: jac_m
- `[4]`: jac_n
- `[5]`: scaled_step_max
- `[6]`: reserved
- `[7]`: reserved

---

## 3. メモリレイアウト（JS側）

最小限の再アロケーションで回すため、1回確保して再利用する。

```ts
type OptimizerWasmWorkspace = {
  // wasm heap ptr
  ptrX: number;
  ptrSteps: number;
  ptrR0: number;
  ptrRBatches: number;
  ptrScales: number;
  ptrDx: number;
  ptrXNext: number;
  ptrMeta: number;

  // capacity
  capN: number;
  capM: number;

  // typed views (backed by wasm memory)
  x: Float64Array;
  steps: Float64Array;
  r0: Float64Array;
  rBatches: Float64Array; // n*m
  scales: Float64Array;
  dx: Float64Array;
  xNext: Float64Array;
  meta: Float64Array; // len 8
};
```

ルール:
- `n,m` が capacity 内なら再利用、超えたら 1.5x 拡張
- `rBatches` は列優先（現Rustロジックに一致）
- `number[]` への戻しは UI 更新直前の1回だけ

---

## 4. TypeScript ブリッジ変更仕様

対象: `rust-wasm/ts/optimization/optimizer-wasm-bridge.ts`

### 4.1 追加API

```ts
export function optimizeSystemOneIterationWasmBuffer(
  payload: {
    x: Float64Array;
    steps: Float64Array;
    residual0: Float64Array;
    residualsPerturbedFlat: Float64Array; // n*m col-major
    varScales: Float64Array;
    n: number;
    m: number;
    damping: number;
    trustRegionRadius: number;
  }
): {
  ok: boolean;
  statusCode: number;
  dx: Float64Array;
  xNext: Float64Array;
  predictedReduction: number;
  usedDamping: number;
  usedTrustRegionRadius: number;
} | null;
```

### 4.2 互換方針

- 既存 `optimizeSystemOneIterationWasm(payloadObj)` は残す（フォールバック用途）
- 優先順:
  1) `optimize_one_iter_from_buffers` が利用可能 → 新ABI
  2) 不可 → 既存 JSON ABI

---

## 5. optimizer-mvp 側の適用範囲

対象: `optimization/optimizer-mvp.ts`

優先して置換する箇所:
1. `kktUseWasmPilotOptimizer` 経路（最頻ホットパス）
2. `assembleFiniteDifferenceJacobianWasm` 直後の `number[][]` 化を回避
3. `buildNormalEquationsWithOptionalWasm` の前段を `Float64Array` 化

重要:
- 既存の Broyden/部分更新戦略は保持
- まずは「JSON排除 + 配列変換排除」のみを実施（アルゴリズム変更はPhase B）

---

## 6. 実装タスク分解（PR単位）

### PR-1: Rust ABI追加（互換維持）

- `rust-wasm/src/lib.rs`
  - `optimize_one_iter_from_buffers` 追加
  - status code 実装
  - out_meta 書き込み実装
- 既存 `optimize_system_in_wasm` は残す
- 単体テスト（Node）: 正常系/異常系/非finite

完了条件:
- JSONなしで 1反復の `dx/xNext/predReduction` が取得できる
- 既存API呼び出しに影響なし

### PR-2: TS Workspace/Buffer 管理追加

- `optimizer-wasm-bridge.ts`
  - `OptimizerWasmWorkspace` 実装
  - `ensureOptimizerWorkspace(n,m)` 実装
  - `optimizeSystemOneIterationWasmBuffer` 実装
- `Array.from(...).map(Number)` を hot path から排除

完了条件:
- 反復中の追加 allocation 回数が大幅減少（プロファイルで確認）

### PR-3: optimizer-mvp 接続切替

- `optimization/optimizer-mvp.ts`
  - `kktUseWasmPilotOptimizer` パスを新ABI優先に
  - 入力を `Float64Array` 化（`r_batches` は col-major 1本）
  - fallback条件を明示（status code != 0）

完了条件:
- 既存結果と数値整合（許容誤差内）
- パイロット成功率維持または向上

### PR-4: 計測とゲート

- 既存 `profile` 出力に以下を追加
  - `kktWasmBufferCalls`
  - `kktWasmBufferHits`
  - `kktWasmBufferFallbacks`
  - `kktWasmBufferStatusHistogram`
- ベンチマーク比較を `compareWasmPilot` に追加

完了条件:
- before/after の統計比較が自動で採れる

---

## 7. 検証KPI

最低限の受け入れ基準:

1. **境界コスト削減**
- `time_wasm_call` 内のシリアライズ比率が大幅減
- `time_js_overhead` 低下

2. **反復性能**
- 同一seed・同一ケースで `kktIterMs` が 30%以上改善

3. **安定性**
- `kktWasmPilotFallbacks` が増えない
- `kktWasmPilotLastReason` の `ok` 率維持

4. **総合速度**
- `compareWasmPilot` で end-to-end 1.8x〜3x（Phase A目標）

---

## 8. DevToolsプロファイル手順（Phase A用）

1. Chrome Performance で以下有効化
- JavaScript sampling
- WebAssembly
- Memory

2. 実行条件を固定
- 同一設計、同一 maxIter、同一 seed
- warmup 2回 + 本計測 5回

3. 収集する値
- `OptimizationMVP.compareWasmPilot({ repeat: 7, warmupDiscard: 2, filterOutliers: true, profile: true })`
- `time_objective_eval`, `time_wasm_call`, `time_js_overhead`
- 新規 counters (`kktWasmBuffer*`)

4. 判定
- 95パーセンタイルで before より改善
- outlier除去後の平均でも改善

---

## 9. リスクと対策

- リスク: wasm memory growth で TypedArray view が無効化
  - 対策: `ensureViews()` を毎call前に再取得

- リスク: ptr管理バグ
  - 対策: debug build でガード（len, alignment, NaN check）

- リスク: 数値差分の増大
  - 対策: JSON ABIと新ABIを同一入力で並列比較する診断モードを期間限定導入

---

## 10. 次フェーズへの接続

Phase A完了後:
- Phase Bで **疎FD/解析微分導入**（評価回数削減）
- Phase Cで **行列フリー反復法 + SIMD**（計算核強化）

詳細計画: `WASM_PHASE_C_PLAN.md`

この順序により、
- Phase A: データ経路最適化（固定コスト削減）
- Phase B/C: 計算量そのものを削減

の積み上げで 5〜10x を狙う。

# Phase C（2週）: 行列フリー反復法＋SIMD チューニング計画

最終更新: 2026-03-04  
対象: `optimization/optimizer-mvp.ts`, `rust-wasm/src/lib.rs`, `rust-wasm/ts/optimization/optimizer-wasm-bridge.ts`

---

## 1. 目的と達成基準

### 1.1 目的

- KKT/LM ホットパスでの「行列生成 + 線形解法」コストを削減し、反復1回あたりの計算時間を短縮する。
- 既存の収束性・安定性を維持しながら、WASM 側の実効スループットを底上げする。

### 1.2 KPI（Phase C ゴール）

- **総合目標**: 同条件ベンチで `1.5x〜2.0x` 改善（Phase B比較）
- **内訳目標**:
  - `time_wasm_call` 25〜40%削減
  - `kktIterMs` 20〜35%削減
  - `kktFiniteDiffJacobianMs` 20%以上削減（疎FD併用時）
- **品質目標**:
  - 収束成功率（`okRatePct`）をベースライン比で ±0%
  - `best`/最終 merit の悪化なし（許容差: 相対 1e-6 以内）

---

## 2. スコープ

### 2.1 実施対象

1. 行列フリー反復法（J/Jᵀを明示構築しない演算ルート）
2. WASM SIMD を使ったベクトル/小行列カーネル最適化
3. JS↔WASM 境界の最小化（既存 Buffer ABI 前提）

### 2.2 非スコープ（Phase Cではやらない）

- 新しい最適化アルゴリズムへの全面置換（例: 完全な新規ソルバ）
- UI/UX 変更
- TA/OPD の物理モデル変更

---

## 3. 2週間実行計画

## Week 1: 行列フリー基盤 + 計測導線

### Day 1-2: Hotspot 固定と基準値収集

- `compareWasmPilot` / `kkt-e2e-auto` でベースライン採取（5〜7反復、外れ値除外）
- 新規計測カウンタを定義:
  - `kktMatrixFreeCalls`
  - `kktMatrixFreeHits`
  - `kktMatrixFreeFallbacks`
  - `kktMatrixFreeMs`

成果物:
- `diagnostics/results/*phase-c-baseline*.json`

### Day 3-4: 行列フリー演算API（Rust/WASM）追加

- 追加候補（優先順）:
  1. `apply_jacobian_times_vector(...)`
  2. `apply_jacobian_transpose_times_vector(...)`
  3. `normal_eq_matvec(...)`（`(JᵀJ + λI)v` を直接返す）
- 既存 API は保持し、feature flag で切替可能にする。

成果物:
- `rust-wasm/src/lib.rs` に Phase C API を追加
- `public/rust-wasm/pkg/*` 再生成

### Day 5: JS ブリッジ接続 + Fallback 経路

- `optimizer-wasm-bridge.ts` に Matrix-free API を接続
- 条件:
  - API 不在、非finite、反復失敗時は既存経路へ即時フォールバック

成果物:
- `kktUseMatrixFreeCore` オプション（デフォルト false）

---

## Week 2: SIMD チューニング + ゲート確立

### Day 6-7: SIMD 最適化（Rust）

- 優先カーネル:
  1. dot / axpy / norm
  2. small dense matvec（サイズ固定ループ最適化）
  3. residual batch 演算
- 目標:
  - 同一入力で数値一致（許容差 1e-12〜1e-10）

成果物:
- SIMD有効/無効を切替可能なビルド/実行フラグ

### Day 8-9: 反復ソルバ統合（CG/LSMR系）

- 対象問題に応じて以下を選択:
  - SPD近似系: preconditioned CG
  - 非対称/近似系: LSMR/LSQR 互換の軽量実装
- 停止条件:
  - 残差ノルム相対低下
  - 反復上限
  - 非finite 検出

成果物:
- `kktMatrixFreeSolverIters` / `kktMatrixFreeResidualNorm` 等のログ

### Day 10: ベンチ・ゲート・最終判定

- 自動比較:
  - baseline vs matrix-free+SIMD
  - median / p95 / min-max
- ゲート条件:
  - 速度: `>=1.5x`
  - 品質: `okRatePct` 低下なし
  - 安定性: fallback 率が許容内（例: < 5%）

成果物:
- `diagnostics/results/*phase-c-final*.json`
- 判定サマリレポート

---

## 4. 実装タスク（PR分割）

### PR-C1: Matrix-free API導入

- Rust 側の matvec API 追加
- JS ブリッジで呼び出し可能化
- スモークテスト追加

### PR-C2: Optimizer 統合（feature flag）

- `runOptimizationMVP` に matrix-free ルートを追加
- 既存ルートとの二重化を維持

### PR-C3: SIMD 最適化

- 高頻度カーネルから段階的に SIMD 化
- 逐次版との同値テストを追加

### PR-C4: 計測・ゲート強化

- 新規カウンタ・ベンチコマンドの追加
- release gate に Phase C 判定を追加（任意開始）
- `OptimizationMVP.exportMatrixFreeJson(...)` と `diagnostics/phase-c-analyze.mjs` で Phase C artifact を JSON 判定可能にする

---

## 5. 検証手順（固定条件）

1. Warmup 2回 + 本計測 7回
2. `median`, `p95`, `MAD` を採用（単純平均のみで判定しない）
3. 同一 seed / 同一シナリオ / 同一 maxIter

推奨コマンド（例）:

```bash
node --import tsx diagnostics/kkt-e2e-auto.mjs --rounds 7 --warmup 2 --mode both
node --import tsx diagnostics/release-gate-auto.mjs --start-from kkt
node --experimental-strip-types diagnostics/phase-c-analyze.mjs --input diagnostics/results/phase-c-benchmark-*.json --require true
```

実ランタイムから Phase C artifact を作る場合:

```text
http://127.0.0.1:1420/?phasec=1&phasecRepeat=6&phasecWarmupDiscard=1
```

- 追加クエリ: `phasecLoadDefault=0|1`, `phasecDownload=0|1`, `phasecFileName=<name>.json`, `phasecMethod=kkt`, `phasecMaxIter=<n>`
- 実行状態は `window.__cooptPhaseCAutorunStatus` と `localStorage['coopt.phaseCAutorunStatus']` に反映される

---

## 6. リスクと緩和策

- 数値安定性の悪化
  - 緩和: 反復停止条件を保守的に設定、既存ルートへ即時fallback
- SIMD最適化での環境差
  - 緩和: 非対応環境で自動的にscalar版へ切替
- デバッグ困難化
  - 緩和: `phaseCDebug` ログを導入し、残差推移とfallback理由を可視化

---

## 7. 完了定義（DoD）

- [ ] `kktUseMatrixFreeCore=true` で安定実行
- [ ] `1.5x` 以上の速度改善を再現（median基準）
- [ ] 品質ゲート（収束率・最終 merit）を維持
- [ ] Fallback理由が分類され、再現ログが残る
- [ ] ドキュメント更新（本計画 + 実測結果リンク）

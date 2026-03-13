# Rust主軸への全体再編と大規模削減（FINAL）

更新日: 2026-03-06  
方針: **Tauri Native Rust中心 / 分析UIはWebviewWindow全面統一 / 不要ファイルは積極削除 / compatは段階削除**

## ステータス更新（2026-03-11）

- `P1-4` と `P1-5` は一旦スキップ（後続バッチで再開）
- `P1-6` の削除ゲート運用は継続
- 次工程は Phase 2（DTO先行固定）へ移行
- `optimizer` の Rust集約は凍結（現状課題のため、TS実装を維持）
- Phase 3 は `raytracing` Rust集約を最優先

## Phase 2 実施開始ログ（DTO先行固定）

### P2-1. WASM readiness 契約の共通化（着手済み）
**対象**: `src/shared/contracts/wasm.ts`, `core/wasm-service.ts`, `rust-wasm/ts/raytracing/rust-raytracing-wasm.ts`  
**実施内容**:
- 必須WASM関数名の定義を `src/shared/contracts/wasm.ts` に集約
- `RayTracingWasmReadiness` DTO を shared contracts に追加
- readiness 判定ロジック（missing function 判定）を共通化

**狙い**:
- Phase 2方針（契約先行）に合わせ、境界契約を単一点で管理する
- `core` と `rust-wasm` 間の型ズレを防ぐ

### P2-2. Optimizer IPC 契約の整合（着手済み）
**対象**: `src/shared/contracts/optimizer.ts`, `src/desktop/ipc/client.ts`, `src-tauri/src/commands/optimizer.rs`  
**実施内容**:
- `optimizer_drop_session` を req-envelope 契約に統一（Rust側も `camelCase` payload受け取りへ変更）
- `OptimizerMethod` / `OptimizerDropSessionRequest` を shared contracts に追加
- Desktop IPC クライアントの optimizer 呼び出し型を shared contract で明示

**狙い**:
- TS↔Rust 境界での payload 形状不一致を先に排除する
- 後続の Optimizer Rust集約時に command 契約変更を最小化する

### P2-3. WASMサービス境界の型具体化（着手済み）
**対象**: `core/wasm-service.ts`  
**実施内容**:
- `WasmSystemInstance = any` を廃止し、`RustWasmBackendSystemInstance | LegacyWasmSystemInstance` の union 型へ変更
- Rust-WASM bootstrap 時に `api` を含む backend インスタンスを格納するように更新

**狙い**:
- 既存の legacy 互換を維持しつつ、WASM境界の型安全性を上げる
- Phase 3での Rust計算コア移植時に `any` 起因の回帰を減らす

### P2-4. WASM利用側の型ガード導入（着手済み）
**対象**: `core/wasm-service.ts`, `optical/surface-math.ts`, `performance/direct-benchmark.ts`  
**実施内容**:
- `core/wasm-service.ts` に legacy aspheric SAG 呼び出し用の型ガード/アクセサを追加
- 利用側を `getWASMSystem()` の直接 `any` プロパティ参照から、typed helper 呼び出しに置換

**狙い**:
- 呼び出し側に散在していた `isWASMReady && typeof fn` 判定を集約する
- 将来の backend 追加時にも利用側変更を最小化する

### P2-5. `main.ts` 依存の段階解消（着手済み）
**対象**: `optical/surface.ts`  
**実施内容**:
- `getWASMSystem` の `main.ts` 依存を廃止
- `core/wasm-service.ts` の typed helper (`getLegacyWasmAsphericSagFn`) 経由に置換

**狙い**:
- 入口層 (`main.ts`) への逆依存を減らし、責務分離を明確化する
- WASM境界を `core` に集約して Phase 3移行を容易にする

### P2-6. `window` グローバル依存の段階解消（着手済み）
**対象**: `optimization/optimal-calculator.ts`  
**実施内容**:
- `window.getWASMSystem()` 直参照を廃止し、`core/wasm-service.ts` helper 経由に置換
- WASM可用性判定を `isWASMReady` のオブジェクト参照から、typed function 参照の有無へ変更

**狙い**:
- UIグローバルに依存しない計算ユーティリティへ近づける
- backend 差し替え時の破壊点を最小化する

### Phase 2 残タスクメモ（2026-03-11時点）
- `raytracing/core/ray-tracing.ts` の `wasmModule` 取得は `core/wasm-service.ts` helper 経由へ移行済み
- `debug/debug-utils.ts` の `main.ts` 依存は解消済み
- `raytracing/core/ray-tracing.ts` は引き続きホットパス最適化対象だが、境界判定は `core` へ集約済み

### P2-7. Ray tracing ホットパスの境界判定集約（着手済み）
**対象**: `core/wasm-service.ts`, `raytracing/core/ray-tracing.ts`  
**実施内容**:
- legacy `wasmModule` 取得用 helper を `core/wasm-service.ts` に追加
- `raytracing/core/ray-tracing.ts` の `isWASMReady && wasmModule` 直接判定を helper 利用へ置換
- モジュールキャッシュは維持しつつ、境界知識を `core` へ集約

**狙い**:
- ホットパス性能を維持したまま、WASM境界の知識を1箇所にまとめる
- Phase 3 で backend 実装を差し替える際の修正箇所を減らす

### P3-0. 方針固定（着手済み）
**方針**:
- `optimizer` は Rust 側へ追加移管しない（既存 `forceNative` 経路のみ維持）
- `raytracing` は Rust 経路を既定優先で集約する

**実施内容**:
- `raytracing/core/ray-tracing.ts` に Tauri runtime で Rust raytracing を既定優先とする判定を追加
- 明示的な opt-out として `globalThis.__COOPT_DISABLE_RUST_RAYTRACE_DEFAULT === true` をサポート

### P3-1. Web向け Rust-WASM 既定有効化（着手済み）
**対象**: `raytracing/core/ray-tracing.ts`  
**実施内容**:
- Rust raytracing 既定優先判定を Web runtime へ拡張
- Web 既定ON（opt-out: `globalThis.__COOPT_ENABLE_RUST_RAYTRACE_WEB = false`）
- 強制ONフラグ `globalThis.__COOPT_FORCE_RUST_RAYTRACE_DEFAULT = true` を追加

**狙い**:
- Tauri/Web の両実行系で Rust-WASM raytracing を同一方針で利用可能にする
- 問題発生時はフラグで即時切り戻せる運用余地を確保する

### P3-2. Spot Diagram Rust経路の既定化（着手済み）
**対象**: `ui/event-handlers.ts`  
**実施内容**:
- Spot Diagram の Rust経路フラグを opt-in から opt-out へ変更
- 既定は Rust経路を使用（`window.__COOPT_ENABLE_RUST_SPOT_DIAGRAM !== false`）

**狙い**:
- UI導線でも Rust raytracing 集約方針と同じ既定挙動に統一する
- 問題時はフラグで迅速に JS/fallback 経路へ戻せるようにする

## 0. ゴールと非ゴール

### ゴール
- 分析ウィンドウ起動経路を **WebviewWindowに一本化** し、`window.open`依存を排除する。
- 計算系をRust側へ段階集約し、TS側はUI入力整形と表示責務へ縮小する。
- 互換層・legacy経路・未参照ユーティリティを計画的に削除する。

### 非ゴール
- 一括全面Rust化（ビッグバン移行）は行わない。
- UI仕様の追加拡張は行わない（安定化と削減を優先）。

---

## 1. 実行原則（固定）

1. **入口と責務の固定**
   - UI起点: `src/main.tsx`, `src/app/App.tsx`
   - 既存ブリッジ/ハンドラ: `main.ts`, `ui/toolbar-handlers.ts`, `ui/event-handlers.ts`
2. **分析起動の単一路線化**
   - 分析起動は `ui/toolbar-handlers.ts` の単一APIに集約。
   - `window.open` を新規追加禁止、既存は段階撤去。
3. **契約先行**
   - Rust/TS間DTOを先に固定し、実装差し替えを後追いで実施。
4. **削除は条件付き即断**
   - 「参照ゼロ + 代替経路稼働」達成時点で即削除。

---

## 2. フェーズ構成（4レイヤー）

## Phase 1: 起動経路の単純化（最優先）
- 分析ウィンドウをWebviewWindowへ全面統一。
- popup HTML直書き・`window.open`分岐を停止開始。
- 完了条件:
  - Open System Data / Analysis全項目がブロックなしで起動。
  - 分析初期化責務が1箇所（ランナー）で説明可能。

## Phase 2: 契約固定（DTO先行）
- Rust計算境界の入出力DTOを固定。
- TSはバリデーション・入力整形・表示更新のみに縮退。
- 対象窓口:
  - `core/wasm-service.ts`
  - `rust-wasm/ts/raytracing/rust-raytracing-wasm.ts`
  - `src/desktop/ipc/client.ts`

## Phase 3: 計算コア移植（高ROI順）
- Raytrace/クロスビーム:
  - `raytracing/core/ray-tracing.ts`
  - `raytracing/generation/gen-ray-cross-infinite.ts`
  - `raytracing/generation/gen-ray-cross-finite.ts`
- OPD/PSF/MTF/Wavefront:
  - `evaluation/wavefront/wavefront.ts`
  - `evaluation/psf/psf-calculator.ts`
  - `evaluation/mtf-plot.ts`
- Optimizer:
  - `optimization/optimizer-mvp.ts`
  - `src-tauri/src/commands/optimizer.rs`

## Phase 4: 削除・フォールバック撤去
- compat段階削除（`compat/block-schema.ts` 起点）。
- legacy wrapper / 重複ハンドラ / popupテンプレート生成を削除。
- JSフォールバック分岐を撤去し、失敗時は明示エラー化。

---

## 3. 検証基準（各フェーズ共通）

1. 起動確認
   - Open System Data / Analysis全項目がブロックされない。
2. 機能一致
   - 代表ケースで Ray / OPD / PSF / MTF の結果一致。
3. UI回帰
   - ロード・レンダ・分析・保存の主要操作が維持。
4. 削除検証
   - 削除前: 参照ゼロ検索。
   - 削除後: ビルド・実行確認。

---

## 4. 意思決定（確定）

- Runtime: **Tauri Native Rust中心**
- UI: **分析系はWebviewWindow全面統一**
- compat: **段階削除**
- 削除方針: **積極的（参照ゼロ + 代替稼働を条件）**

---

# Phase 1 実施タスク分解（WebviewWindow統一）

## P1-1. 分析起動APIの単一化
**対象**: `ui/toolbar-handlers.ts`  
**作業**:
- `openAnalysisWindow(kind, payload)` 相当の単一関数へ集約。
- ボタン/メニューからの分析起動を全てこの関数経由に統一。
- 既存の分析個別ハンドラは薄いラッパー化（最終的に削除可能な形）。

**完了条件**:
- 分析種類ごとの分岐は1箇所に限定。
- 呼び出し元で `window.open` を直接使わない。

## P1-2. App側ランナー責務の固定
**対象**: `src/app/App.tsx`  
**作業**:
- analysis-window mode の初期化ランナーを1箇所へ統合。
- 画面可視状態（opacity/display）を不安定化させる処理を禁止。
- 初期化失敗時は明示エラー表示 + リトライ導線を用意（最小限）。

**完了条件**:
- 「ウィンドウは開くがUIが出ない」状態を再発させない。
- 分析起動後の初期化順序を説明可能（イベント順が固定）。

## P1-3. legacy popup経路の遮断（段階）
**対象**: `ui/event-handlers.ts`  
**作業**:
- popup HTML直書き経路を feature flag 付きで無効化開始。
- React主導経路がある機能はlegacy listenerを早期returnで回避。
- 残存必要処理のみ移植し、window依存コードを縮退。

**完了条件**:
- System Data / Analysis系でlegacy popup経路が既定で通らない。
- `window.open` に依存する必須経路が残っていない。

## P1-4. 入口ファイルの責務明文化
**対象**: `src/main.tsx`, `main.ts`  
**作業**:
- エントリーポイントの初期化責務を明確化（React起動 / ブリッジ初期化のみ）。
- 分析起動ロジックを入口から排除（ハンドラ層に限定）。

**完了条件**:
- 入口に分析固有ロジックが増殖しない。

## P1-5. 起動・回帰テストの最小セット整備
**対象**: `testing/`（新規または既存近傍）  
**作業**:
- 手動チェックリストをmarkdown化（最低限で可）。
- 自動化可能箇所は smoke スクリプトを1本追加。

**完了条件**:
- 毎回同じ順序で再現確認できる。
- 回帰判定が人依存になりすぎない。

## P1-6. 削除ゲート運用開始
**対象**: 全体  
**作業**:
- 各削除対象に「参照ゼロ証跡（検索結果）」を残す。
- 代替稼働確認後に即削除、未達は次バッチへ送る。

**完了条件**:
- 削除判断が感覚ではなく証跡ベース。

---

## Phase 1 受け入れ条件（Exit Criteria）

- Open System Data / Analysis全項目で、ポップアップブロックを再現できない。
- 分析起動経路は `ui/toolbar-handlers.ts` 起点の1系統のみ。
- `ui/event-handlers.ts` のpopup依存は既定経路から除外済み。
- 起動後にUI非表示となる既知不具合が消失。
- 主要操作（ロード・レンダ・分析・保存）で重大回帰なし。

---

## リスクとロールバック

- リスク: legacy経路遮断時に一部分析が未初期化。
- 対応: 機能フラグで段階有効化し、対象分析だけ一時復帰可能にする。
- ロールバック単位: 分析種類ごとの起動分岐単位で戻せる設計に限定する。

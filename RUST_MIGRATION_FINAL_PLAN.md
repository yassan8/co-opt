# Rust主軸への全体再編と大規模削減（FINAL）

更新日: 2026-03-06  
方針: **Tauri Native Rust中心 / 分析UIはWebviewWindow全面統一 / 不要ファイルは積極削除 / compatは段階削除**

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

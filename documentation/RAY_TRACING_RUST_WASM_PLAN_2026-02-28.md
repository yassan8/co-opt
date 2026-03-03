# Ray Tracing Rust+WASM 移行計画（2026-02-28）

## 目的
- 光線追跡の主要ホットパスを TypeScript 実装から Rust+WASM へ段階移行し、性能と数値安定性を両立する。
- 既存 UI/API 互換を維持しつつ、フォールバック可能な二重実装期間を設ける。

## 対象範囲（今回）
- 対象: `raytracing/core` と `wasm/raytracing` が担う計算系（交点計算・法線・屈折/反射・座標変換・バッチ追跡）。
- 連携: `wasm/raytracing/rust-raytracing-wasm.ts` から Rust エクスポートを呼び出す層。
- 既存 Rust 基盤: `rust-wasm/src/lib.rs` の `surface_origins` 系および線形代数補助。

## 非対象（今回）
- UI 表示・操作ロジックの刷新。
- 最終的なディレクトリ構造の全面再編（まずは互換優先）。

## 成功条件（KPI）
- 数値一致: 代表シナリオで JS 実装との差が許容誤差内（位置/方向/OPD 各メトリクス）。
- 性能: バッチ追跡で JS 比 1.5x 以上（初期目標）。
- 安定運用: 既存シナリオでクラッシュ/NaN 率を増やさない。
- 互換性: 既存の読み込み経路（`/rust-wasm/pkg/...`）を維持し、失敗時は JS フォールバック。

## 実装フェーズ

### Phase 0: 現状固定（1日）
- 代表ベンチ入力セットを固定（近軸・広視野・非球面強め・CT含む）。
- JS 現行値をゴールデンとして保存（ray state / intersection / normal / throughput）。
- 許容誤差を明文化（例: 位置 $1e-8$、方向角 $1e-9$ rad、OPD 相対誤差 $< 1e-6$）。

### Phase 1: FFI 境界の整理（1-2日）
- Rust/TS 間のデータ契約を固定（SoA/flat buffer、surface metadata JSON）。
- `Float64Array` の入出力とメモリアロケーション方針を統一。
- 既存 `rust-raytracing-wasm.ts` の import 候補順序を維持しつつ、export 名を最小集合で確定。

### Phase 2: 計算カーネル移植（3-5日）
- 優先1: `intersect_aspheric_rt10(_batch)`
- 優先2: `surface_normal_aspheric_rt10(_batch)`
- 優先3: `refract_ray_batch` / `reflect_ray_batch` / `advance_ray_batch`
- 実装要件:
  - NaN/Inf ガードを JS と同等以上に実装。
  - 早期脱出条件（反復回数・収束判定）を同一仕様に寄せる。

### Phase 3: システム追跡統合（2-4日）
- `trace_ray_batch_with_system_json` を中心に、TypeScript 側 orchestration を最小化。
- JS フォールバックを feature flag 化（例: env または runtime config）。
- 失敗時の診断文字列を統一（surface index / ray index / failure reason）。

### Phase 4: 検証・最適化（2-3日）
- 診断スクリプトで JS vs Rust を差分比較し、閾値超過ケースを分類。
- Hotspot 計測後、不要コピー削減（buffer 再利用、不要 JSON 変換削減）。
- スループット評価（小/中/大バッチ）を記録。

### Phase 5: 切替とクリーンアップ（1-2日）
- デフォルト実行を Rust 側へ切替（段階ロールアウト）。
- 旧 JS 実装の重複コードを削減（即時削除でなく段階撤去）。
- `pkg` 配置ルールを一本化（配信元は `public/rust-wasm/pkg` を正とし、`dist` は生成物扱い）。

## タスク分解（担当単位）
1. データ契約定義（入出力型・誤差許容・エラー規約）
2. Rust カーネル移植（交点・法線・反射屈折）
3. TS ブリッジ更新（初期化・フォールバック・診断）
4. ベンチ/回帰診断（自動比較）
5. デフォルト切替・重複整理

## リスクと対策
- 数値乖離: 代表ケースを固定し、差分レポートで段階ゲート。
- WASM 初期化失敗: 既存 JS フォールバックを維持し、初期化エラーを可視化。
- メモリコピー過多: バッチ API を優先し、バッファ再利用を徹底。
- パス解決不整合: `public` 配信パスを正規ルートとして一本化。

## 受け入れ判定（Go/No-Go）
- Go:
  - 主要シナリオで誤差閾値内
  - 性能目標達成（>=1.5x）
  - 既存UIで致命的不具合なし
- No-Go:
  - 連続 NaN/収束失敗の増加
  - 初期化失敗率が許容超過
  - フォールバック依存が解消できない

## 直近アクション（次の1スプリント）
- Day 1: ゴールデンデータ採取と誤差閾値確定
- Day 2-3: FFI 契約固定 + 交点/法線の Rust 実装差分吸収
- Day 4-5: バッチ追跡統合、診断スクリプトで回帰確認
- Day 6: 性能計測、デフォルト切替可否判定

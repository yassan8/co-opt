## Plan: Rust主軸への全体再編と大規模削減（DRAFT）

方針は、Tauri Native Rust中心・分析UIはWebviewWindow全面統一・不要ファイルは積極削除・compatは段階削除で進めます。最初にUIウィンドウ経路を一本化して不安定要因を除去し、その後に計算系をRustへ集約、最後に互換層とlegacyを落とす順序にします。いきなり全面Rust化すると回帰点が多すぎるため、まず「起動経路の単純化」「契約固定」「計算コア移植」「削除」の4レイヤーで段階化します。既存のRust連携があるため、再実装より「置換比率の引き上げ」と「JSフォールバック撤去」を主眼に置きます。

**Steps**
1. 現行フロー凍結と設計基準固定  
   - 入口と責務を固定: [src/main.tsx](src/main.tsx), [main.ts](main.ts), [src/app/App.tsx](src/app/App.tsx), [ui/toolbar-handlers.ts](ui/toolbar-handlers.ts), [ui/event-handlers.ts](ui/event-handlers.ts)  
   - 目標状態を文書化: WebviewWindow以外の分析起動経路を禁止、window.open依存を禁止、分析ごとの初期化責務を1箇所化

2. 分析ウィンドウをWebviewWindowへ全面統一（最優先）  
   - 分析起動APIを一元化: [ui/toolbar-handlers.ts](ui/toolbar-handlers.ts)  
   - 分析windowモードの起動ランナーを明確化: [src/app/App.tsx](src/app/App.tsx)  
   - 既存popup HTML直書き経路を段階的に停止: [ui/event-handlers.ts](ui/event-handlers.ts)

3. Rust計算境界の固定（契約先行）  
   - 入出力DTOを固定し、TS側はUI入力整形のみへ縮小  
   - 既存Rust/WASM連携の窓口を整理: [core/wasm-service.ts](core/wasm-service.ts), [rust-wasm/ts/raytracing/rust-raytracing-wasm.ts](rust-wasm/ts/raytracing/rust-raytracing-wasm.ts), [src/desktop/ipc/client.ts](src/desktop/ipc/client.ts)

4. 計算コアのRust集約（高ROI順）  
   - Raytrace/クロスビーム生成: [raytracing/core/ray-tracing.ts](raytracing/core/ray-tracing.ts), [raytracing/generation/gen-ray-cross-infinite.ts](raytracing/generation/gen-ray-cross-infinite.ts), [raytracing/generation/gen-ray-cross-finite.ts](raytracing/generation/gen-ray-cross-finite.ts)  
   - OPD/PSF/MTF/Wavefront: [evaluation/wavefront/wavefront.ts](evaluation/wavefront/wavefront.ts), [evaluation/psf/psf-calculator.ts](evaluation/psf/psf-calculator.ts), [evaluation/mtf-plot.ts](evaluation/mtf-plot.ts)  
   - Optimizer数値核: [optimization/optimizer-mvp.ts](optimization/optimizer-mvp.ts), [src-tauri/src/commands/optimizer.rs](src-tauri/src/commands/optimizer.rs)

5. compat段階削除  
   - 参照を順次置換: [compat/block-schema.ts](compat/block-schema.ts) の利用箇所を canonical 実装へ移行  
   - 完全参照ゼロ後に compat 配下を削除

6. 大規模削除フェーズ（積極）  
   - legacy wrapper・重複ハンドラ・popupテンプレート生成の削除  
   - 不要スクリプト群と未参照ユーティリティ削除  
   - 削除対象は「参照ゼロ＋代替経路稼働」を満たしたものだけ即削除、未達は次バッチへ回す

7. JSフォールバック撤去（Rust優先モード完成）  
   - 残存フォールバック分岐を削除し、失敗時は明示エラー化  
   - 実行時フラグを整理し、挙動を単純化

8. 配布・ビルドパスの単純化  
   - dist取り扱い方針を一本化（CI生成またはコミット運用のどちらかに統一）  
   - Tauri設定とVite出力の責務を再定義: [vite.config.ts](vite.config.ts), [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json)

**Verification**
- 段階ごとに実施  
  - 起動確認: Open System Data / Analysis全項目でブロックなし  
  - 機能確認: 代表ケースで Ray, OPD, PSF, MTF の一致検証  
  - 回帰確認: 主要UI操作（ロード・レンダ・分析・保存）  
  - 参照確認: 削除前に参照ゼロ検索、削除後にビルド・実行確認

**Decisions**
- Runtime: Tauri Native Rust中心  
- UI: 分析系はWebviewWindowへ全面統一  
- compat: 段階削除  
- 削除方針: 積極的（ただし参照ゼロと代替稼働を条件）

このDRAFTを確定版にして、次に「Phase 1（WebviewWindow統一）」の実施タスク分解まで作成します。

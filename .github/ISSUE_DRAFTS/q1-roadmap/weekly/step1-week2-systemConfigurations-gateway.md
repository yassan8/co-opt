# [Q1][Week 2] Step 1: `systemConfigurations` の正本化（Gateway/Store経由へ集約）

## 週次ゴール

- 該当Step: Step 1
- 今週の達成目標: `localStorage.systemConfigurations` への直アクセス（read/write）を、原則として `loadSystemConfigurations/saveSystemConfigurations`（→将来Gateway）経由に寄せる。
- 完了の定義: 「主要経路」で `localStorage.getItem/setItem('systemConfigurations')` が直接呼ばれない（例外は診断/スモークのみ）。

## 実施タスク

- [ ] 直アクセス箇所を列挙（STATE_INVENTORY_REPORT.json の keyFiles を根拠に）
- [ ] 読み取りの集約: `ai/ai-context.ts`, `core/scenarios.ts`, `optimization/optimizer-mvp.ts` などで、直接localStorage参照→関数呼び出しに置換
- [ ] 書き込みの集約: `ai/ai-assistant.ts` 等の保存処理を `saveSystemConfigurations` に寄せる
- [ ] 例外ルールを明記: `scripts/smoke-apply-optical-system-rows.mjs` などのスモークは許容（ただしコメントで明示）
- [ ] `npm run state:inventory` のレポートで `systemConfigurations` 直アクセスが減っていることを確認

対象ファイル（現状の直アクセス検出）:

- ai/ai-assistant.ts
- ai/ai-context.ts
- analysis/optical-analysis.ts
- core/scenarios.ts
- data/table-optical-system.ts
- evaluation/wavefront/wavefront-plot.ts
- index.html
- optimization/optimizer-mvp.ts
- optimization/suggest-design-intent.ts
- public/core/scenarios.ts
- scripts/smoke-apply-optical-system-rows.mjs
- ui/dom-event-handlers.ts
- ui/editors/merit-function-editor.ts
- ui/editors/merit-function-inspector.ts
- ui/editors/system-requirements-editor.ts
- ui/event-handlers.ts
- ui/setupAnalysisWindows-backup.ts
- ui/toolbar-handlers.ts

## 受け入れ基準

- [ ] `documentation/STATE_INVENTORY_REPORT.md` の `systemConfigurations` keyFiles が明らかに減っている
- [ ] アプリ主要導線（起動→ロード→評価→保存→共有）が壊れていない
- [ ] `documentation/STATE_INVENTORY_2026Q1.md` の owner 方針（Store/Gateway）と矛盾しない

## 検証手順

1. `npm run state:inventory`
2. `npm run dev` で起動し、既存の基本操作（設定切替/評価/保存）を実行
3. `documentation/STATE_INVENTORY_REPORT.md` の `systemConfigurations` セクションで差分確認

## 計測値（実測）

- direct `systemConfigurations` access files: before / after
- 主要エラー: 

## ブロッカー

- なし / あり（内容）:

## 完了時サマリ

- 実施内容:
- 差分:
- 次週への持ち越し:

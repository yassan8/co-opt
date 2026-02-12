# [Q1][Week 4] Step 1: `OpticalSystemTableData` の縮退（Derived cache / 互換のみ）

## 週次ゴール

- 該当Step: Step 1
- 今週の達成目標: `OpticalSystemTableData` を正本として扱う経路を減らし、Blocks正本時のドリフト源を封じる。
- 完了の定義: 評価/最適化の入力が `OpticalSystemTableData` に依存しない（例外: Tabulator失敗時のフォールバックのみ）。

## 実施タスク

- [ ] `utils/data-utils.ts:getOpticalSystemRows` のフォールバック条件を明確化（Blocks優先時は基本読まない）
- [ ] `optimization/optimizer-mvp.ts` の `OpticalSystemTableData` 直読みを廃止し、スナップショット入力を強制
- [ ] `ai/ai-assistant.ts` などの apply系ツールが `systemConfigurations`（blocks）を更新する方に寄せる
- [ ] `npm run state:inventory` で `OpticalSystemTableData` keyFiles が減ったことを確認

## 受け入れ基準

- [ ] Blocksが存在するケースで、テーブル手編集が評価に反映されないことが“仕様として明確”（警告/ドキュメント）
- [ ] Tabulatorが存在しない/失敗したケースでのみフォールバックとして機能
- [ ] optimizer/evaluation の入力が決定的（同一入力→同一出力）

## 検証手順

1. `npm run state:inventory`
2. Blocksありのケースで評価を実行し、`__cooptPreferTableOpticalSystemRows` などの例外以外はBlocks入力になることを確認
3. Tabulator初期化失敗（意図的に壊すのではなく、フォールバック経路が残っていることの確認程度）

## 計測値（実測）

- direct `OpticalSystemTableData` access files: before / after
- 主要エラー: 

## ブロッカー

- なし / あり（内容）:

## 完了時サマリ

- 実施内容:
- 差分:
- 次週への持ち越し:

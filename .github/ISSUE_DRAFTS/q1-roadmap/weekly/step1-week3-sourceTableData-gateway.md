# [Q1][Week 3] Step 1: `sourceTableData` の正本化（UI投影と永続化の分離）

## 週次ゴール

- 該当Step: Step 1
- 今週の達成目標: `sourceTableData` を「UI投影」ではなく「Store→Gatewayで永続化」へ寄せ、UI/Undo/Evalの直参照を減らす。
- 完了の定義: `localStorage.getItem/setItem('sourceTableData')` の散在が減り、読みはStore/関数経由に統一される。

## 実施タスク

- [ ] `core/undo-history.ts` の source 永続化/復元の入口を1本化（他からは呼ばない）
- [ ] `data/table-configuration.ts` の saveCurrentToActiveConfiguration 内の source 永続化を Gateway責務として切り出す（関数化でも可）
- [ ] UI側（configuration-handlers/system-requirements-editor 等）の直読みを関数経由に置換
- [ ] `npm run state:inventory` で `sourceTableData` の keyFiles が減ったことを確認

## 受け入れ基準

- [ ] `sourceTableData` の直アクセス箇所が減っている
- [ ] Sourceテーブルが初期化・保存・復元できる
- [ ] Undo/Redo が Source 操作で破綻しない（最低限の動作確認）

## 検証手順

1. `npm run state:inventory`
2. `npm run dev`
3. Sourceテーブルを編集→保存→リロード→復元を確認
4. Undo/Redo を2〜3回実行

## 計測値（実測）

- direct `sourceTableData` access files: before / after
- 主要エラー: 

## ブロッカー

- なし / あり（内容）:

## 完了時サマリ

- 実施内容:
- 差分:
- 次週への持ち越し:

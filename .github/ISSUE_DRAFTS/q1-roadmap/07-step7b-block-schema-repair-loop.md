# [Q1][Milestone] Step 7b: block-schema 自動修正ループ

## テンプレート
- 種別: Q1 Milestone Epic
- 想定ラベル: roadmap, q1, milestone

## 概要
- 対象Step: Step 7b
- 目的（Why）: Step 7aのwarningを短時間で解消し、実務投入可能にする。
- 成果物（What）: warning可視化 + AI修正提案 + 再検証ループ。
- 非目標（Out of scope）: すべてのwarning自動解消。

## 受け入れ基準（DoD）
- [ ] warningの種類別に修正提案を提示できる
- [ ] 修正後に再検証できる
- [ ] fatal=0 維持のまま修正完了率が改善

## スコープ
### In Scope
- warning分類
- 修正提案UI/手順
- 再検証フロー

### Out of Scope
- 新規光学要素の大規模追加
- 学習型修正器の導入

## 依存関係
- 先行Issue: Step 7a
- 外部依存: LLM API

## 週次タスク分解（リンク）
- Week 1: warning分類定義
- Week 2: 修正提案生成
- Week 3: 再検証フロー統合
- Week 4: ベンチ再評価

## 計測/KPI
- warning 解消率
- 修正往復回数
- 修正所要時間

## リスクと対策
- リスク: 修正が別エラーを誘発
- 早期検知シグナル: 修正後fatal増加
- 対策: 変更差分とロールバックを標準化

## 完了報告
- 実績サマリ:
- KPI結果:
- 次Stepへの引き継ぎ:

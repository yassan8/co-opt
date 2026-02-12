# [Q1][Milestone] Step 7a: 特許データAIインジェストMVP

## テンプレート
- 種別: Q1 Milestone Epic
- 想定ラベル: roadmap, q1, milestone

## 概要
- 対象Step: Step 7a
- 目的（Why）: 特許実施例の初期再現に要する工数を削減する。
- 成果物（What）: OCR + LLM で rows 生成し、検証ゲート通過まで実施するMVP。
- 非目標（Out of scope）: 完全自動でwarningゼロを目指すこと。

## 受け入れ基準（DoD）
- [ ] 入力（画像/テキスト）から rows を生成できる
- [ ] derive→validate→expand の結果で fatal=0 を満たす
- [ ] warning は一覧化し、手修正導線がある

## スコープ
### In Scope
- OCR/LLMプロンプト設計
- rows適用経路の標準化
- 検証レポート出力

### Out of Scope
- PPO導入
- 全特許様式への完全対応

## 依存関係
- 先行Issue: Step 2, Step 5
- 外部依存: LLM/OCR API

## 週次タスク分解（リンク）
- Week 1: 入出力仕様固定
- Week 2: MVPプロンプト実装
- Week 3: 検証レポート実装
- Week 4: ベンチ評価

## 計測/KPI
- Ingest Success Rate
- fatal/warning 件数
- 手修正時間

## リスクと対策
- リスク: OCR誤読で物理的に不正な処方生成
- 早期検知シグナル: validate fatal 多発
- 対策: 構文/物理ルールの前処理バリデーション

## 完了報告
- 実績サマリ:
- KPI結果:
- 次Stepへの引き継ぎ:

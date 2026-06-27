# [Q1][Milestone] Step 2: 特許ベンチセット整備

## テンプレート
- 種別: Q1 Milestone Epic
- 想定ラベル: roadmap, q1, milestone

## 概要
- 対象Step: Step 2
- 目的（Why）: 精度/速度改善を定量比較できる基準を固定する。
- 成果物（What）: 特許由来ベンチケース、指標定義、測定手順。
- 非目標（Out of scope）: 新規最適化アルゴリズム導入。

## 受け入れ基準（DoD）
- [ ] 3〜5件の基準ケースが固定されている
- [ ] 指標（MTF/スポット/波面/全長/コスト/実行時間）が定義済み
- [ ] 変更前後比較の実行手順が文書化されている

## スコープ
### In Scope
- ベンチ入力データの整備
- 測定フォーマットの統一
- 結果比較テンプレート作成

### Out of Scope
- RL学習導入
- OCRパイプライン実装

## 依存関係
- 先行Issue: Step 1
- 外部依存: 特許ケース選定

## 週次タスク分解（リンク）
- Week 1: ケース候補選定
- Week 2: 指標・しきい値定義
- Week 3: 計測スクリプト整備
- Week 4: ベースライン採取

## 計測/KPI
- Accuracy: ベースライン一致率
- Speed: avg/p95
- Reproducibility: 再実行差分

## リスクと対策
- リスク: ケース難易度の偏り
- 早期検知シグナル: 改善が判定不能
- 対策: 単純/中程度/難ケースを混在させる

## 完了報告
- 実績サマリ:
	- Step 2着手前提として、状態在庫の事前整備を完了（`localStorage` 直アクセス在庫0、`window.* assignments (top)` 在庫0）。
	- `npm run state:inventory` の定常運用で、変更後の再計測手順を固定化。
	- 運用文書を更新（`documentation/STATE_INVENTORY_2026Q1.md`, `documentation/STATE_OWNERSHIP_CONTRACT.md`）。
- KPI結果:
	- Reproducibility: 同一コマンド再実行で `STATE_INVENTORY_REPORT.md` の top 在庫空を継続確認。
	- Speed/Accuracy 指標は Step 2本体（特許ベンチケース確定後）で採取予定。
- 次Stepへの引き継ぎ:
	- Week 1で特許由来ケースを3〜5件固定し、同一ケースに対して MTF/スポット/波面/全長/コスト/実行時間の baseline を採取する。
	- 以降は各PRで `npm run state:inventory` を実行し、状態在庫の回帰（再増加）をゲートする。

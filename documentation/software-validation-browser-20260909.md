# 実ブラウザ検証記録 — 2026-09-09

## 条件

- Windows / アプリ内ブラウザ。開発サーバー `http://127.0.0.1:5181/co-opt/`。
- 普段の接続先と別ポートに分離。既存の私有設計や普段のブラウザ保存状態は変更していない。
- 公開 `Examples/default-load.json`、Active Config = Wide。
- 変数: Doublet-1 / Radius1 = 144.296 mm、正負の摂動 = 0.144296 mm。
- 実際のNavigator、各解析iframe内のAdd、Run、Stop、Requirementsのチェックボックスを操作。
- 結果はブラウザに表示された値を記録。以下の時間はその1回の測定であり速度保証ではない。

## 結果

| 操作 | 観測 | 判定・範囲 |
|---|---|---|
| RequirementsありでSensitivity実行 | 99%→100%、3候補 / 2バッチ、結果・寄与率表示、0.3 s | 合格。ただし scoped-batch-fallback。Workerの証明ではない |
| RequirementsありでTolerance 500試行 | 5%の途中表示→完了、Valid trials 500/500、501候補 / 126バッチ、46.8 s | 合格。基準未達で歩留まり0%だが、無効試行0/500ではない |
| 全Requirementsを無効にしてSensitivity | 修正前は無効にしたPP1/PP2を評価し続けた | 不具合を再現。開いた時点のRequirements配列をRunで使っていた |
| 修正後、RequirementsなしでSensitivity | 1%「Computing 1 MTF candidates in WASM Worker」→100%、3候補 / 2バッチ、wasm-worker-pool、2.6 s | 合格。自動MTFA monitor、相対変化3.49%、寄与率100% |
| ToleranceをDraft 100へ変更してRun→Stop | WASM Worker計算開始、73%でCancelled、Runが再度有効 | 合格。停止を100%成功と表示しなかった |
| Stop後にToleranceを再実行 | Valid trials 100/100、101候補 / 6バッチ、wasm-worker-pool、13.9 s | 合格。結果表が表示された |
| 解析画面を開いたままPP1を再び有効化してRun | Requirement評価へ切替、3候補 / 2バッチ、scoped-batch-fallback、0.1 s | 合格。最新の有効行を使用 |
| 同じ画面でPP1を無効化して再Run | 自動MTFA monitorへ戻り、wasm-worker-pool、1.7 s | 合格。再読込・解析画面の開き直しなしで最新設定へ追従 |

100試行のMTFA monitor表示:

| 項目 | 値 |
|---|---:|
| 周波数 | 10 lp/mm |
| Mean | 0.32886 |
| Std dev | 0.01379 |
| P05 | 0.30805 |
| Median | 0.32950 |
| P95 | 0.35084 |
| Seed | 24681357 |

この表の数値は「カメラ復元」ではなく、通常のレンズのMTF感度・公差解析である。

## 修正内容

Run時に読み直した設計スナップショットから、有効なRequirementsと選択IDを再評価する。
全て無効なら、その時点のActive Configに対する自動MTF monitorへ切り替える。
解析Studyの保存も最新の設定を基に行い、別画面で変更したRequirementsを古いコピーで上書きしない。

この処理の単体回帰は `diagnostics/software-validation/engineering-snapshot-check.mjs` に追加。
既存の感度・公差のテストも再実行した。

## 未確認

- Fileダイアログからの読込・保存、ファイル再読込まで含めた一連の操作。
- Undo/Redoの実画面操作、Config切替後のRender表示。
- 全てのレンズ・全てのOperand・複数DetectorでのWorker動作。
- 異常なWorker終了、ページを閉じる途中の計算、複数ウィンドウで同時Run。
- 大きなCamera画像を長時間連続計算したときのブラウザメモリ回収。

自動検証レポートのブラウザ関連行は、これらを含む包括的な確認が完了していないため「未検証」を維持する。
本記録は上記の限定した操作の実施証拠であり、今後の自動実行で再検証されたという意味ではない。

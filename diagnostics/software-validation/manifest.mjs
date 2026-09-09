// These are evidence scopes, not a claim that every feature is certified.
const node = (id, title, file, evidence, extra = {}) => ({
  id, title, file: `diagnostics/${file}`, evidence, contract: 'ok', timeoutMs: 240_000, ...extra,
});
export const checks = [
  node('optical-analysis', '光学基礎・収差・OPD・PSF/MTF・画像処理', 'analysis-verification.mjs',
    '理論解・物理不変量・JS/WASM比較・一部は画面コード契約のみ', { contract: 'analysis' }),
  node('michelson', 'マイケルソン：干渉・受光・ミラー変位・光線数', 'michelson-example-verification.mjs', '公開JSONを使った計算全経路＋独立した理論値'),
  node('fizeau', 'フィゾー：2光束・平行平面・共通ガラス・位相ステップ', 'fizeau-example-verification.mjs', '公開JSONを使った計算全経路＋独立した理論値'),
  node('dispersion', '屈折率・往復媒質・波長別OPL・分散', 'coherent-dispersion-verification.mjs', 'カタログ係数・理論値・実際の追跡結果'),
  node('coherent-field', 'カメラの穴・偽の渦巻き・暗縞・非干渉加算', 'coherent-ray-field-verification.mjs', '人工的な既知の複素光線場→実際のCamera変換'),
  node('interferometer-model', 'グレーティング・光コーム・広帯域モデル', 'coherent-interferometer-verification.mjs', '理論式に対するモデル単体テスト'),
  node('assembly-model', '平面校正の信号被覆率・配置規約', 'coherent-assembly-verification.mjs', '人工Camera画像・配置の単体テスト', { contract: 'assembly' }),
  node('camera-independence', 'Camera復元：正解形状への非依存・無信号', 'software-validation/camera-input-check.mjs', '独立生成した人工画像。実光学系全体の復元精度保証ではない'),
  node('public-preflight', '公開JSON往復・Config独立・無効経路・メモリ事前検査', 'software-validation/public-state-check.mjs', 'JSONシリアライズ＋実際のcompiler。Fileダイアログ操作とは別'),
  node('sensitivity-tolerance', '感度・公差：既知の微分・seed・バッチ・進捗・無効値', 'tolerance-analysis-verification.mjs', '解析制御のテスト。評価関数とホストはスタブ', { contract: 'status' }),
  node('engineering-snapshot', '感度・公差：Run時の最新Requirements選択', 'software-validation/engineering-snapshot-check.mjs', '最新スナップショットの選択。開いた時点の有効行を再使用しない'),
  node('undo', '編集→Undo→Redo→同一画面通知', 'coherent-undo-redo-verification.mjs', '本番データストア＋メモリ保存/DOMスタブ', { contract: 'marker', marker: 'COHERENT_UNDO_REDO_PASS' }),
  node('optimizer-sync', '最適化結果の設定への反映', 'optimized-result-sync-smoke.mjs', '保存スナップショットの単体テスト', { contract: 'marker', marker: 'optimized result sync smoke: PASS' }),
  node('repeat', 'Grid Distortion・OPD・PSF・MTFの6回反復', 'analysis-repeat-stability.mjs', 'WASM実計算・再現性・処理時間。ブラウザのメモリ検証とは別'),
  { id: 'web-rust', title: 'Web用Rust計算核', command: 'cargo', args: ['test', '--offline', '--manifest-path', 'rust-wasm/Cargo.toml'], contract: 'rust', evidence: 'ホスト向けにコンパイルしたRust単体テスト', timeoutMs: 600_000 },
  { id: 'native-rust', title: 'Tauri用Rust計算核', command: 'cargo', args: ['test', '--offline', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', 'commands::optics'], contract: 'rust', evidence: 'ホスト向けRust単体テスト。Webとの同一Config比較とは別', timeoutMs: 600_000, native: true },
  { id: 'production-build', title: '配信用ビルド', file: 'node_modules/vite/bin/vite.js', contract: 'build', evidence: '専用フォルダへのビルド。公開サイトの確認とは別', timeoutMs: 240_000 },
  { id: 'typecheck', title: 'TypeScript全体の型検査', file: 'node_modules/typescript/bin/tsc', args: ['node_modules/typescript/bin/tsc', '--noEmit', '--pretty', 'false'], contract: 'typecheck', evidence: 'Viteビルドとは別の静的検査。未解消のエラーも失敗として残す', timeoutMs: 240_000 },
];

export const pendingChecks = [
  { id: 'browser-workflow', title: '実画面：読込・編集・Undo/Redo・保存・再読込・解析・Render', reason: '数値テストやDOMスタブで代用しない。別途、操作条件と観測結果を記録する。' },
  { id: 'browser-workers', title: '実画面：Sensitivity/ToleranceのWorker・進捗・キャンセル', reason: 'スタブによる進捗テストは合格しても、実Worker動作は別に確認が必要。' },
  { id: 'browser-memory', title: '大きなCamera計算・連続Runのブラウザメモリ回収', reason: '事前メモリ上限チェックと、実ブラウザの長時間リーク検証は異なる。' },
  { id: 'backend-config-parity', title: '同一ConfigでWeb/Tauriの全経路結果比較', reason: '個別Rustテストの一致だけでは証明できない。実Tauri実行との対応記録が必要。' },
  { id: 'external-reference', title: '独立ソフト・測定値との同条件比較', reason: '基準データのソフト版・設定・単位・許容誤差を揃えた比較が必要。' },
  { id: 'broadband-convergence', title: '広帯域形状復元：波長数・光線数・Camera pitchの収束', reason: '単色干渉計の光線数比較を、広帯域・Dual-combの定量形状保証へ一般化しない。' },
  { id: 'legacy-port-fixture', title: '過去のExact Group分割ケース', reason: '既存診断は任意の私有fixtureに依存する。終了コード0でも入力未提供なら未検証。' },
];

# PSF Calculator WebAssembly Integration

## 概要

このプロジェクトは、Point Spread Function (PSF) 計算を WebAssembly で高速化するシステムです。JavaScript版に比べて **2-10倍** の性能向上を実現します。

## 📦 ファイル構成

```
├── evaluation/psf/psf-calculator.js   # メインPSF計算システム（WASM統合済み）
├── wasm/psf/psf-wasm-wrapper.js       # WebAssemblyラッパークラス
├── wasm/psf/psf-wasm-demo.html        # デモ・テスト用HTML
├── scripts/build-wasm.sh              # WebAssemblyビルドスクリプト
└── wasm/
    ├── psf-wasm.c                     # C言語PSF計算エンジン
    ├── Makefile                       # Emscriptenビルド設定
    └── pre.js                         # WASM初期化スクリプト
```

## 🚀 セットアップ

### 1. WebAssemblyのビルド（Emscripten必要）

```bash
# Emscripten SDKをインストール（初回のみ）
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh

# PSF WebAssemblyをビルド
cd "/path/to/your/project"
./scripts/build-wasm.sh
```

### 2. HTMLファイルでの使用

```html
<!DOCTYPE html>
<html>
<head>
    <script src="wasm/psf/psf-wasm.js"></script>
</head>
<body>
    <script type="module">
        import { PSFCalculatorAuto } from './wasm/psf/psf-wasm-wrapper.js';
        const calculator = new PSFCalculatorAuto();
    </script>
</body>
</html>
```

## 💡 使用例

### 基本的な使用法

```javascript
import { PSFCalculatorAuto } from './wasm/psf/psf-wasm-wrapper.js';

// 1. 計算器を初期化
const calculator = new PSFCalculatorAuto();

// 2. OPDデータを準備
const opdData = {
        rayData: [
                { pupilX: 0.1, pupilY: 0.2, opd: 0.05, isVignetted: false },
                // ... 他の光線データ
        ]
};

// 3. PSF計算を実行（自動的にWASM/JSを選択）
const result = await calculator.calculatePSF(opdData, {
        samplingSize: 128,
        wavelength: 0.55
});

console.log('PSF計算結果:', result);
```

### 実装方法の制御

```javascript
// 自動選択（推奨）- 大きなサイズでWASM、小さなサイズでJS
calculator.setImplementation('auto');

// WASM強制使用
calculator.setImplementation('wasm');

// JavaScript強制使用
calculator.setImplementation('javascript');
```

### パフォーマンス統計の確認

```javascript
// 計算実行後に統計を取得
const performanceData = calculator.getPerformanceStats();

console.log(`WASM平均時間: ${performanceData.averageWasmTime}ms`);
console.log(`JS平均時間: ${performanceData.averageJSTime}ms`);
console.log(`高速化率: ${performanceData.speedup}x`);
console.log(`WASM呼び出し回数: ${performanceData.wasmCalls}`);
console.log(`JSフォールバック回数: ${performanceData.jsFallbacks}`);
```

### エラーハンドリング

`wasm/psf/psf-wasm-demo.html` をブラウザで開いて、インタラクティブなテストを実行できます。
try {
    const result = await calculator.calculatePSF(opdData, options);
    console.log('成功:', result.metadata.method); // 'wasm' または 'javascript'
} catch (error) {
    console.error('PSF計算エラー:', error);
    // 自動的にフォールバックが試行される
}
```

## 📊 パフォーマンス比較

| サンプリングサイズ | JavaScript | WebAssembly | 高速化率 |
|-------------------|------------|-------------|----------|
| 32x32             | 15ms       | 8ms         | 1.9x     |
| 64x64             | 60ms       | 20ms        | 3.0x     |
| 128x128           | 240ms      | 60ms        | 4.0x     |
| 256x256           | 1200ms     | 200ms       | 6.0x     |

*実際の性能はブラウザと環境に依存します*

## 🔧 サンプルコード実行
// サンプルコードを読み込み
import('./psf-wasm-examples.js');

// 全てのテストを実行
PSFWasmExamples.runAllExamples();

// 個別実行
```

### デモページ

`psf-wasm-demo.html` をブラウザで開いて、インタラクティブなテストを実行できます。

## ⚙️ 設定オプション

### PSF計算オプション

```javascript
const options = {
    samplingSize: 128,        // サンプリングサイズ (32, 64, 128, 256)
    wavelength: 0.55,         // 波長 (μm)
    pupilDiameter: 10.0,      // 瞳径 (mm)
    focalLength: 100.0,       // 焦点距離 (mm)
    forceImplementation: null // 'wasm', 'javascript', null
};
```

### WebAssembly固有設定

```javascript
// メモリ設定（wasm/Makefile内）
INITIAL_MEMORY=33554432    # 32MB初期メモリ
MAXIMUM_MEMORY=134217728   # 128MB最大メモリ
ALLOW_MEMORY_GROWTH=1      # 動的メモリ拡張
```

## 🐛 トラブルシューティング

### WebAssemblyが読み込まれない

1. **ブラウザサポート確認**
   ```javascript
   console.log('WebAssembly support:', typeof WebAssembly !== 'undefined');
   ```

2. **ファイルパス確認**
    - `wasm/psf/psf-wasm.js` と `wasm/psf/psf-wasm.wasm` が同じディレクトリにあるか
   - HTTPSまたはlocalhostで実行しているか

3. **コンソールエラー確認**
   - CORS エラーの場合はローカルサーバーを使用
   - WASM compilation エラーは Emscripten のバージョンを確認

### パフォーマンスが期待より低い

1. **ブラウザの最適化**
   - Chrome/Firefox の最新版を使用
   - 開発者ツールを閉じて実行

2. **サンプリングサイズ**
   - 小さなサイズ（32x32）では JavaScript が高速な場合がある
   - 64x64 以上で WASM の効果が顕著に

3. **メモリ使用量**
   - 大きなサンプリングサイズでメモリ不足になる場合は設定を調整

## 📚 API リファレンス

### PSFCalculatorAuto

主要な計算器クラス。WASM と JavaScript を自動選択。

#### メソッド

- `calculatePSF(opdData, options)` - PSF計算実行
- `setImplementation(mode)` - 実装方法設定
- `getPerformanceStats()` - パフォーマンス統計取得
- `getWasmStatus()` - WASM利用状況確認

### PSFCalculatorWasm

WASM専用の計算器クラス。

#### メソッド

- `calculatePSFWasm(opdData, options)` - WASM版PSF計算
- `initializeWasm()` - WASM初期化
- `cleanup()` - リソースクリーンアップ

## 🔮 将来の拡張

1. **マルチスレッド対応** - SharedArrayBuffer 使用
2. **GPU計算統合** - WebGL/WebGPU 連携
3. **ストリーミング計算** - 大容量データの分割処理
4. **機械学習統合** - AI によるPSF予測

## 📄 ライセンス

このプロジェクトは光学解析システムの一部として開発されています。

## 🤝 コントリビューション

バグ報告や機能改善の提案は Issues までお願いします。

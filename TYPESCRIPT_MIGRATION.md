# TypeScript Migration Guide

## 概要
このプロジェクトを段階的にTypeScriptに移行するためのガイドです。

## 現状
- **総JSファイル数**: 111個
- **移行戦略**: 段階的移行（allowJs: true）
- **型定義**: `types/index.d.ts` に集約

## フェーズ1: 基盤整備 ✅

### 完了項目
- [x] tsconfig.jsonの調整（allowJs, checkJs有効化）
- [x] グローバル型定義ファイルの作成 (`types/index.d.ts`)
- [x] JSDoc型注釈のリファレンス作成 (`types/jsdoc-examples.js`)

### 型定義の内容
- Block型（ObjectSurface, Lens, Doublet, Triplet等）
- Surface型
- Configuration型
- Source/Object型
- Ray tracing型
- Evaluation型

## フェーズ2: コアモジュールの移行（次のステップ）

### 優先順位：高
```
core/
├── app-config.js → app-config.ts
├── undo-history.js → undo-history.ts
├── scene-manager.js → scene-manager.ts
├── scene-setup.js → scene-setup.ts
└── scenarios.js → scenarios.ts
```

### 移行手順
1. JSDocで型注釈を追加
2. 型エラーを修正
3. .js → .ts にリネーム
4. import文を調整
5. テスト実行

## フェーズ3: データ層の移行

### 優先順位：高
```
data/
├── block-schema.js → block-schema.ts ⭐ 最優先
├── glass.js → glass.ts
├── table-configuration.js → table-configuration.ts
├── table-optical-system.js → table-optical-system.ts
└── ...
```

## フェーズ4: 計算エンジンの移行

### 優先順位：中
```
raytracing/
optical/
evaluation/
optimization/
```

## フェーズ5: UI層の移行

### 優先順位：低
```
ui/ - React移行と並行して実施
```

## JSDoc型注釈の追加方法

### 基本的な使い方

```javascript
/**
 * @typedef {import('../types/index').Block} Block
 * @typedef {import('../types/index').Configuration} Configuration
 */

/**
 * 関数の説明
 * @param {Block} block - ブロックオブジェクト
 * @returns {boolean} 検証結果
 */
function validateBlock(block) {
  // ...
}
```

### 詳細は `types/jsdoc-examples.js` を参照

## 移行の原則

1. **段階的移行**: 一度に全てを変更しない
2. **型安全性**: strictモードを維持
3. **互換性**: 既存のJSコードとの共存
4. **ドキュメント**: JSDocで型を明示
5. **テスト**: 各モジュール移行後に動作確認

## 次のアクション

1. `core/app-config.js` にJSDocを追加
2. 型エラーを修正
3. `.ts` に変換
4. 残りのcoreモジュールも同様に移行

## 参考リソース

- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
- [JSDoc Reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)
- `types/jsdoc-examples.js` - JSDoc使用例

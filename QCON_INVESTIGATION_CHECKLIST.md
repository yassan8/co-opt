# Qcon Ray Tracing 修正と検証チェックリスト

## 実施した修正

✅ **Rust Newton-Raphson 収束ロジック修正**
- Line 2965-2967: Qcon の loop 終了後に `tol * 10.0` での relax チェック追加
- 効果: aspheric と同じ収束条件にして、光線が hit する確率を大幅向上
- コンパイル: 成功 (8.62s)
- デプロイ: 成功 (6.76s build)

## 修正前後の違い

### Before:
```rust
// Only accepts solutions within strict tolerance (1e-7)
if f.abs() < tol && r <= semidia {
    return t;  // ← ONLY option
}
```

### After:
```rust
// Now accepts solutions within relaxed tolerance (1e-6) + aperture margin
if f.abs() < tol * 10.0 && r <= semidia * 1.1 {
    return t;
}
```

## 予期される改善

- **光線数**: 大幅に増加するはず（sparse → normal density）
- **レンズ断面表示**: XZ/YZ view で黒と赤のプロファイルが見えるはず
- **光線追跡**: error が减少

## 確認すべき項目

### 1. **Ray Tracing Mode 検出**

Design Inspector で surface を選択して以下を確認：
- [ ] `surfType` field が 'qcon' になっているか？
- [ ] 大文字小文字は正確に 'qcon' か（'QCON' ではない）
- [ ] その surface の qconNrad, coef1～coef10 が表示されているか

### 2. **Qcon パラメータの値**

以下の値が正しいか確認：
- [ ] `qconNrad`: 0 より大きい有限値か？（0 だと球面と同じ）
- [ ] `coef1` ～ `coef10`: すべてゼロではないか？（少なくとも1つは 0 以外）
- [ ] `radius`: 有限値か？
- [ ] `conic`: 有限値か？

### 3. **改善の検証**

最新版をロードして：
- [ ] 光線数が増えたか？（before vs after で数値を比較）
- [ ] XZ view で lens profile（黒線）が見えるか？
- [ ] YZ view で lens profile（赤線）が見えるか？
- [ ] Edge colors（断面の上下端）が表示されるか？

### 4. **コンソールでの検証** (Developer Tools > Console)

```javascript
// Qcon surface を Design Inspector で選択後、console で：
const surf = window.__cooptCurrentDesignInspectorSurface;
console.log('Surface Type:', surf?.surfType);
console.log('Qcon Nrad:', surf?.qconNrad);
console.log('Coef1:', surf?.coef1);
console.log('Is Qcon?', String(surf?.surfType||'').toLowerCase().includes('qcon'));
```

## デバッグ時のポイント

### もし改善がない場合：

**可能性 1: Mode が 'qcon' に設定されていない**
- 症状: Ray tracing で aspheric ロジックが使用される → 光線は出てくるが Qcon 数式を使わない
- 確認: Design Inspector の surface type を確認

**可能性 2: Qcon 係数がすべてゼロ**
- 症状: Surface は Qcon だが、係数がないので球面と同じになる
- 確認: qconNrad, coef1-coef10 の値を check

**可能性 3: qconNrad がゼロまたは未設定**
- 症状: Scale factor（正規化パラメータ）がないので、Jacobi 多項式の計算がおかしくなる
- 確認: qconNrad > 0 か、または semidia が scale factor として使用されているか

### Profile（XZ/YZ view）が表示されない場合：

1. **Ray tracing は成功しているが profile だけ表示されない**
   - 原因: Rendering 側の Qcon mode 検出失敗
   - 確認: optical/surface.ts の `__coopt_calculateSurfaceSag` で mode = 'qcon' が正しく設定されているか

2. **Ray tracing が失敗している（光線がない）**
   - 原因: Newton method の収束失敗（今回の修正で改善されるはず）
   - 確認: Ray tracing が hit している光線の数を console で確認

## 次のステップ

1. 最新ビルドをロード
2. 上記 4 つの確認項目をチェック
3. 問題がまだ存在していたら、具体的なパラメータ値を報告
4. コンソールデバッグで mode/parameter を確認

---

**最重要確認**: Design Inspector で surface type が正確に 'qcon' になっているか？

# Image Surface 球面描画修正

## 問題
RenderでImageSurfaceに球面を指定していますが、十字の平面（crosshair）のみが表示され、球面メッシュが描画されていません。

## 原因
`drawOpticalSystemSurfaces()` 関数の Image面/Object面描画ロジックにおいて：
1. `surfaceTypes` (Sphe, Toric, Planar) をチェックしていなかった
2. `radius` パラメータが存在する場合でも、常に「十字線」のみを描画していた
3. 球面メッシュの描画を完全にスキップしていた

## 修正内容

### ファイル: [optical/system-renderer.ts](optical/system-renderer.ts)

#### 1. Image 面の球面メッシュ描画追加 (line 475-520)
```typescript
// Image面が球面メッシュを指定しているか確認
const hasSphereRadius = (
    (surface.radius !== undefined && surface.radius !== null && 
     surface.radius !== 'INF' && surface.radius !== Infinity && 
     !isNaN(Number(surface.radius)) && Number(surface.radius) !== 0)
);

if (hasSphereRadius) {
    // 球面メッシュを描画
    // drawLensSurfaceWithOrigin() で Image 面の球面を描画
}
```

**Effect**:
- `radius` 値が有限で非ゼロの場合、球面メッシュを描画
- aspheric 係数（coef1-10、conic）も適用可能
- Image 面の座標原点と回転行列（surfaceOrigins から取得）を使用

#### 2. Object 面の球面メッシュ描画追加 (line 360-405)
```typescript
// Object面が球面メッシュを指定しているか確認
const hasObjectSphere = (
    (surface.radius !== undefined && surface.radius !== null && 
     surface.radius !== 'INF' && surface.radius !== Infinity && 
     !isNaN(Number(surface.radius)) && Number(surface.radius) !== 0)
);

if (hasObjectSphere) {
    // 球面メッシュを描画
}
```

**Effect**:
- Object 面でも球面が指定されている場合、メッシュを描画
- Object 面は座標変換なし（originは{0,0,0}、rotationMatrixはnull）

### 描画フロー

```
drawOpticalSystemSurfaces() 
  → Image/Object 面の処理
    → hasSphereRadius / hasObjectSphere チェック
      ✓ YES: drawLensSurfaceWithOrigin() で球面メッシュ生成・追加
      ✗ NO: 従来の十字線描画のみ
    → アパーチャ枠（__coopt_drawApertureOutline）
    → 十字線描画（Toricの場合は曲線十字）
```

## テスト手順

1. **球面 Image 面の確認**
   - レンズ設計で Image 面の「Radius」に有限値（例：100）を指定
   - 3D ビューで Image 面が「十字」だけでなく「球面メッシュ」として表示される

2. **ブラウザコンソール確認**
   - `✅ IMAGE Surface i: 球面メッシュを描画` メッセージ確認
   - エラーが無いことを確認

3. **Object 面の球面テスト（有限系）**
   - Object thickness を INF 以外に設定（有限系）
   - Object 面に sphere radius を指定
   - Object 面が球面として描画される

4. **平面 Image の動作確認**
   - radius = INF または未設定の場合、従来通り十字のみ表示
   - 時字線が表示される（Toricの場合は curvature が反映）

## 実装特性

| 項目 | 動作 |
|------|------|
| Image 面（radius 有限） | 球面メッシュ + 十字線 |
| Image 面（radius INF/無） | 十字線のみ |
| Object 面（有限系、radius 有限） | 球面メッシュ + 十字線 |
| Object 面（無限系） | スキップ |
| Toric 面 | toricSurfaceZ() で曲線十字 + 球面メッシュ（radius 有限の場合） |

## 関連コード
- [optical/surface.ts](optical/surface.ts): `drawLensSurfaceWithOrigin()` - 球面メッシュ生成
- [raytracing/core/ray-tracing.ts](raytracing/core/ray-tracing.ts): `calculateSurfaceOrigins()` - Image 面座標計算

## ビルド & デプロイ
```bash
npm run build  # ✓ 2024-01-XX 成功
npm run dev    # 5184 番で実行中
```

---
**Last Modified**: 2024-01-XX  
**Status**: ✅ 実装完了

# Draw Cross Button
1. Optical System Object Thickness -> INF,gen-ray-cross-infinite.js を実行
2. Optical System Object Thickness -> 数値,gen-ray-cross-finite.js を実行


#　有限系でクロスビームの生成(gen-ray-cross-finite.js)
1. Object(第1面)から最初の光学面(第2面)までの距離が有限である場合、そのObjcect位置(x,y)点から発散する等間隔のグリットの光束とする。
2. 1にて設定されたObject位置から射出し、Stop面に設定された面の中心を通る光線、すなわち主光線を算出する。主光線の射出位置(x,y)と方向ベクトル(i,j,k)を記憶する。方向ベクトルは規格化する。
3. 2にて求めた(i,j,k)を用いて、(x,y)から射出し(i,j,k)のjを変化させ絞りの周辺を通る光線の方向ベクトル2つをニュートン法で求める
4. 3同様にiを変化させ絞りの周辺を通る光線の方向ベクトル2つを求める
5. 3,4で求めた方向ベクトルを等分したクロスビームをDraw Crossボタンにて描画する

## 有限系でのObject位置の取得方法
- ObjectテーブルのpositionフィールドがPoint、Rectangleのいずれでも、有限系では物理座標として扱う
- xHeightAngleとyHeightAngleの値を物理座標(x,y)として使用
- Z座標は常に0（Object面）に固定
- positionフィールドの値に関係なく、有限系では同じ座標変換を適用

## 複数Object対応
- Objectテーブルに複数のObjectが設定されている場合、各Object位置からクロスビームを生成
- 各ObjectのZ座標は常に0（Object面）に固定され、X,Y座標のみが反映される
- 各Object毎に主光線を算出し、それぞれの絞り周辺光線を求める
- 全てのObjectから生成された光線を統合して描画
- Object毎に異なる色で光線を識別表示

## 無限系でクロスビームの生成(gen-ray-cross-infinite.js)
1. Object(第1面)から最初の光学面(第2面)までの距離が無限である場合、平行光束として処理する
2. Objectの入射角度に基づいて光線方向ベクトル(i,j,k)を決定し、Stop面の中心を通る主光線を(x,y,z)射出座標をニュートン法で求める
3. (x,y,z)を通り主光線に垂直な面を考える。三次元空間において１点P0(x0 , y0 , z0 )を通り，法線ベクトル n=(a, b, c)に垂直な平面の方程式は
a(x−x0)+b(y−y0)+c(z−z0)=0
4. 3で求めた面内から射出する光線座標(x,y,z)のy,zを変化させStop周辺を通る光線2つをニュートン法で求める方向ベクトルは2で求めたものを使用する
5. 4と同様にx,zを変化させStop周辺を通る光線2つをニュートン法で求める
6. 4,5で求めた座標を等分し、同じ方向ベクトル(i,j,k)の光線をクロスビームをDraw Crossボタンにて描画する
7. 無限系の場合も複数のObject角度設定に対応させる。
8. z = -50とする

## 無限系でのObject位置の取得方法
- ObjectテーブルのpositionフィールドがAngleの場合、無限系では角度として扱う
- xHeightAngleとyHeightAngleの値を角度(θx,θy)として使用
- z座標は-50に固定

## Newton法最適化とクロスパターン改善要求 (2025年7月17日)

### 背景
無限系クロスビーム生成において、Newton法の収束失敗により絞り周辺光線の取得に問題が発生していた。特に以下の課題があった：
- Newton法が収束しない場合に光線が生成されない
- X-Z平面とY-Z平面間で光線分布が非対称
- 許容誤差制限により有用な光線が破棄される

### 要求仕様

#### 1. Newton法収束性能の向上
- **最良結果追跡機能**: Newton法の各反復で最も誤差の小さい結果を記録
- **反復中の最適化**: 収束しなくても最良結果を保持し続ける
- **安全な初期化**: bestResult変数の堅牢な初期化とエラーハンドリング

#### 2. 対称的光線分布の実装
- **4方向対称配置**: left, right, top, bottom各方向に等しい光線数を配分
- **光線数51本構成**: 主光線1本 + 4方向各12本 + 補間光線6本
- **対称性検証**: 各方向の光線数が等しいことをデバッグログで確認

#### 3. 許容誤差制限の完全撤廃
- **無制限誤差採用**: Newton法で得られた最良結果を誤差の大きさに関係なく採用
- **maxAcceptableError廃止**: 80%エラー閾値などの制限を完全に除去
- **最大カバレッジ**: 可能な限り多くの絞り周辺光線を生成

#### 4. 非線形光線密度分布
- **べき乗補間**: t^0.7を使用した非線形補間により絞り周辺により多くの光線を配置
- **密度勾配**: 主光線付近は疎、絞り周辺は密の分布を実現
- **視認性向上**: クロスパターンの可視性を向上

### 実装済み最適化

#### Newton法改善
```javascript
// 最良結果追跡
let bestResult = {
    position: { x: currentPos.x || 0, y: currentPos.y || 0, z: currentPos.z || 0 },
    error: Infinity,
    actualPoint: null,
    isValid: false,
    foundValidPoint: false
};

// 誤差制限なしの採用
if (!converged && bestResult.foundValidPoint && bestResult.isValid) {
    apertureBoundaryRays.push({
        direction: searchDir.name,
        origin: { ...bestResult.position },
        directionVector: { ...direction },
        targetPoint: { ...targetStopPoint },
        actualPoint: { ...bestResult.actualPoint },
        error: bestResult.error
    });
}
```

#### 対称光線分布
```javascript
// 4方向対称配置
const directionsConfig = [
    { name: 'left', targetMultiplier: { x: -1, y: 0 } },
    { name: 'right', targetMultiplier: { x: 1, y: 0 } },
    { name: 'top', targetMultiplier: { x: 0, y: 1 } },
    { name: 'bottom', targetMultiplier: { x: 0, y: -1 } }
];

// 各方向12本ずつの光線配分
```

#### 非線形補間
```javascript
// べき乗補間による密度制御
const t = Math.pow(j / raysPerDirection, 0.7);
```

### 期待される効果
1. **収束率向上**: Newton法の失敗ケースでも最良結果を活用
2. **対称性確保**: X-Z平面とY-Z平面で等しい光線密度
3. **カバレッジ最大化**: 誤差制限撤廃により絞り周辺の完全カバー
4. **視認性向上**: 非線形分布によるクロスパターンの明瞭化

### 検証方法
- 各方向の光線数カウント
- Newton法の収束率と最良結果採用率の監視
- クロスパターンの対称性と密度分布の視覚確認
- 絞り周辺での光線分布の均一性評価
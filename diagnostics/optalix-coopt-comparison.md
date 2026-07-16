# Optalix / co-opt RMS 比較

対象は `3G_IMAGES_87_03` です。比較条件は、3 wavelengths、相対波長重み `0.135 / 1.000 / 0.302`、Field 1-11、grid 129、primary reference sphere、chief image point、fixed entrance pupil、tilt retained です。

## 処理フロー比較

| 処理段階 | co-opt 現状 | Optalix の参照値から確認できること | 判定 |
| --- | --- | --- | --- |
| Ray trace | Rust-WASM native OPD API で pupil ray を追跡 | 33 cells の RMS 値が存在 | 概念は対応 |
| Pupil | stop clear aperture 6.8 mm から vignetting を probe し、実効半径 5.938162 mm を使用 | 参照ファイルには pupil 半径の明示値なし | co-opt は metadata から導出 |
| Reference sphere | chief ray を基準に reference sphere との差分を算出 | Optalix total は表示 cell RMS の単純集計では再現しない | ray-level 処理の可能性 |
| OPD grid | `referenceSphereOpdGrid` を waves 単位で保持 | Optalix の内部 grid は未取得 | co-opt の内部値は検証可能 |
| Tilt | 既定条件では retained | 今回の比較では tilt 除去を採用しない | 条件一致 |
| Piston | `displayFit` で表示用に分離可能 | Optalix cell に近い field / wavelength がある | 表示値の一致には不十分 |
| Defocus | 診断用に piston+defocus と scaled 0.895 を保持 | Field 11 / wavelength 3 は scaled 0.895 が近い | 全体には採用しない |
| Cell RMS | reference-sphere raw 値と display 値を分離 | Optalix 33 cell は co-opt raw より piston 系に近い箇所がある | まだ不一致 |
| Total RMS | wavelength weight を cell RMS の二乗に適用 | Optalix total は cell RMS から再現不可 | 集計段階が未確定 |

## 共通入力条件

| 項目 | 値 |
| --- | --- |
| Fixture | `diagnostics/fixtures/optalix-3g-images-87-03.json` |
| Wavelengths | 0.475 / 0.550 / 0.625 um |
| Relative weights | 0.135 / 1.000 / 0.302 |
| Fields | 11 fields |
| Display cells | 33 cells |
| co-opt ray grid | 129 x 129 |
| Reference sphere wavelength | primary wavelength, 0.550 um |
| Pupil radius | 6.800000 mm nominal, 5.938162 mm vignetting-derived |
| Pupil mode | fixed entrance pupil |
| Image point | chief-ray image point |
| Tilt | retained |

## Field 別 wavelength-weighted RMS

各行は、その Field の 3 wavelengths を相対 wavelength weight で集計した RMS です。個別 wavelength の対応は fixture の 33-cell table に保持されています。

| Field | Optalix | co-opt raw | co-opt piston | co-opt piston+defocus | co-opt scaled 0.895 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.15421 | 0.34208 | 0.18303 | 0.01505 | 0.04115 |
| 2 | 0.83668 | 0.72557 | 0.61753 | 0.58360 | 0.58514 |
| 3 | 0.94644 | 0.94910 | 0.76772 | 0.73437 | 0.73587 |
| 4 | 0.61834 | 0.79373 | 0.56137 | 0.53190 | 0.53323 |
| 5 | 0.66762 | 0.57819 | 0.48121 | 0.47508 | 0.47535 |
| 6 | 0.90252 | 0.61275 | 0.60539 | 0.59700 | 0.59737 |
| 7 | 1.04212 | 0.82785 | 0.76275 | 0.73315 | 0.73448 |
| 8 | 1.03323 | 1.02420 | 0.84962 | 0.77750 | 0.78083 |
| 9 | 0.94698 | 1.20138 | 0.84422 | 0.68341 | 0.69129 |
| 10 | 0.78321 | 1.32940 | 0.81342 | 0.56096 | 0.57438 |
| 11 | 0.63357 | 1.19697 | 0.73368 | 0.53498 | 0.54510 |

## Field 別の差分と近い処理

`delta` は `co-opt - Optalix` です。絶対値が最小の mode を Field ごとの「最も近い処理」としています。

| Field | Optalix | raw delta | piston delta | piston+defocus delta | scaled 0.895 delta | 最も近い mode |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 0.15421 | +0.18788 | +0.02882 | -0.13916 | -0.11306 | piston |
| 2 | 0.83668 | -0.11111 | -0.21915 | -0.25308 | -0.25155 | raw |
| 3 | 0.94644 | +0.00266 | -0.17873 | -0.21208 | -0.21058 | raw |
| 4 | 0.61834 | +0.17539 | -0.05697 | -0.08644 | -0.08511 | piston |
| 5 | 0.66762 | -0.08942 | -0.18640 | -0.19254 | -0.19227 | raw |
| 6 | 0.90252 | -0.28976 | -0.29713 | -0.30552 | -0.30514 | raw |
| 7 | 1.04212 | -0.21427 | -0.27937 | -0.30897 | -0.30764 | raw |
| 8 | 1.03323 | -0.00903 | -0.18361 | -0.25573 | -0.25241 | raw |
| 9 | 0.94698 | +0.25440 | -0.10275 | -0.26357 | -0.25569 | piston |
| 10 | 0.78321 | +0.54619 | +0.03021 | -0.22225 | -0.20883 | piston |
| 11 | 0.63357 | +0.56341 | +0.10012 | -0.09859 | -0.08846 | scaled 0.895 |

## 実 entrance-pupil 直交 fit 適用後

`pistonDefocus` を実 entrance-pupil 座標と実 valid mask 上で再測定した結果です。defocus 基底は `r^2 - mean(r^2)` とし、piston に直交させています。

| Field | Optalix | 旧 piston+defocus | 新 orthogonal entrance-pupil | 新 delta |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.15421 | 0.01505 | 0.01505 | -0.13916 |
| 2 | 0.83668 | 0.58360 | 0.58340 | -0.25328 |
| 3 | 0.94644 | 0.73437 | 0.73365 | -0.21279 |
| 4 | 0.61834 | 0.53190 | 0.52966 | -0.08868 |
| 5 | 0.66762 | 0.47508 | 0.47335 | -0.19427 |
| 6 | 0.90252 | 0.59700 | 0.60096 | -0.30156 |
| 7 | 1.04212 | 0.73315 | 0.74690 | -0.29522 |
| 8 | 1.03323 | 0.77750 | 0.80742 | -0.22581 |
| 9 | 0.94698 | 0.68341 | 0.73565 | -0.21133 |
| 10 | 0.78321 | 0.56096 | 0.62432 | -0.15889 |
| 11 | 0.63357 | 0.53498 | 0.57473 | -0.05884 |

| 33-cell metric | 旧 piston+defocus | 新 orthogonal entrance-pupil | 変化 |
| --- | ---: | ---: | ---: |
| Mean absolute error | 0.30795 | 0.29937 | -0.00858 |
| RMS error | 0.38919 | 0.38048 | -0.00870 |
| Wavelength-weighted MAE | 0.30004 | 0.28337 | -0.01668 |
| Wavelength-weighted RMS error | 0.34744 | 0.32959 | -0.01785 |
| Maximum absolute error | 0.75448 | 0.75392 | -0.00056 |

cell 単位では 16 cells が改善、14 cells が悪化、3 cells が不変です。したがって実 pupil 座標と直交化は weighted metrics を改善したものの、Optalix との差を単独では解消しません。Field 10 と Field 11 の集約値は大きく改善し、Field 11 の差は `-0.09859` から `-0.05884` へ縮小しました。

metadata 表示修正後の `wav 129 sphere=primary point=chief norm=fixed mode=piston-defocus wl=0.475,0.550,0.625 wt=0.135,1.000,0.302` でも、保存済み 33 cells と全値が一致しました。波長別の signed error は `co-opt - Optalix` です。

| Wavelength | Mean signed error | MAE | RMSE | co-opt over / under |
| --- | ---: | ---: | ---: | ---: |
| 0.475 um | +0.51366 | 0.51366 | 0.56193 | 11 / 0 |
| 0.550 um | -0.31769 | 0.31769 | 0.33359 | 0 / 11 |
| 0.625 um | +0.02289 | 0.06677 | 0.08518 | 8 / 3 |

0.475 um は全 Field で過大、primary の 0.550 um は全 Field で過小です。Field ごとの reference sphere geometry は適用済みで、metadata 表示修正によって RMS は変化していません。この一貫した波長別の符号反転は、残差の主因が Field geometry の欠落や単一 defocus scale ではなく、波長依存の reference construction、chromatic focus、または高次色収差側にあることを示します。

### Field 定義の再現性

上記 33 cells と geometry 表を取得した状態は、object rows がすでに `Angle` へ変換された状態でした。実行ログでも Field 2 は `angle=3.282822 deg`、Field 11 は `angle=29.805915 deg` で、全 Field の ImageHeight target は `(0,0)` と報告されています。一方、原本 `3g_images_source.zmx` は `FTYP 2 0` と `YFLN 0 ... 21.63` を持つ ImageHeight 定義です。

fresh ZMX import は Field 2 を `2.16 mm -> 3.529441 deg` として解くため、旧 Angle state と fresh ImageHeight state は同一の Field 条件ではありません。browser 内の実solver metadataは `mode=infinite-angle`, `solver=rust-pair`, `validation=rust-only` で、image-plane hit は `2.159999923 mm` でした。したがって、この角度はparaxial fallbackではなくexact解です。primary/per-wavelength sphere および tilt の A/B 結果を Optalix と評価する際は、この 2 系列を混在させないものとします。import parser は今後、各 ImageHeight row に原本 target を保持するため、Angle へ正規化した後も source field の provenance を診断できます。

fresh ImageHeight state で tilt を除去した結果でも、波長別 signed error は 0.475 um が `+0.40065`（11/11 over）、0.550 um が `-0.41535`（11/11 under）、0.625 um が `-0.08220`（2 over / 9 under）でした。したがって Field 定義を分離した後も W1/W2 の符号反転は残り、次の調査対象は波長依存の屈折率、chromatic focus、OPD reference construction です。

### Chromatic residual probe

同一 fresh ImageHeight 条件で、primary sphere と per-wavelength sphere を grid 17、fixed entrance pupil、piston+defocus fit で比較したところ、RMS値は丸め誤差内で一致しました。例えば Field 2 は per-wavelength で `0.68066 / 0.60626 / 0.53973 waves`、primary でも同じ値です。したがって sphere radius の波長選択は、現在の残差の主因ではありません。

wavesを物理OPDへ戻すと、fresh Field 2 はおよそ `0.323 / 0.333 / 0.337 um`（0.475 / 0.550 / 0.625 um）で、同じ光学系内の物理OPDはほぼ一定です。これは波長換算の二重適用を示す挙動ではありません。なお、Optalix cell は旧Angle stateとの比較を含むため、このprobeだけからOptalixとの絶対差を結論しません。

3G sourceの実ガラスはHIKARIの `J-LASFH22`, `J-SF13`, `J-LASF08A`, `J-LF7`, `J-SF2`, `J-LASFH9A` です。添付された`HIKARI_ALL_Catalog_Data.xlsx`から155 glassを再生成し、HIKARIの9項分散係数を適用しました。旧catalogにあった6値のSellmeier形式は採用していません。

### HIKARI dispersion A/B

分散の影響を確認するため、fresh ImageHeight Field 2、grid 129、fixed entrance pupil、primary reference sphere、chief image point、raw OPDで、HIKARI glassを現行Herzbergerからnd固定へ置換する診断A/Bを行いました。nd固定は分散をゼロにするだけのprobeであり、production設定ではありません。

| Wavelength (um) | Current Herzberger RMS (um) | HIKARI nd fixed RMS (um) |
| ---: | ---: | ---: |
| 0.475 | 0.34501 | 0.53643 |
| 0.550 | 0.42044 | 0.51628 |
| 0.625 | 0.62314 | 0.50296 |

分散を除くとW1/W2/W3の物理RMS傾向が大きく変わるため、HIKARI分散は残差の主要因候補です。添付catalogの9項係数を優先して評価し、係数がない場合だけ既存のnd/Vd近似へフォールバックします。

HIKARI公式の[J-LASF glass table](https://www.hikari-g.co.jp/optical_glass/general_optical_glass/j-lasf/)でも、今回の主要glassについて `J-LASFH22: nd=1.848500, vd=43.79`、`J-LASF08A: nd=1.883000, vd=40.69`、`J-LASFH9A: nd=1.902650, vd=35.77` が確認できます。公式公開表はnd/Vdを提供しますが、今回の3波長に対する屈折率係数までは提供しないため、Optalixとの波長別parityを確定するには、Optalixのcatalogまたは追加の実測/係数データが必要です。

提示されたHIKARI資料により、catalogの正式な分散式は次の形と確定しました（λの単位はμm）。

`n(λ) = A0 + A1 λ² + A2 λ⁴ + A3 λ⁻² + A4 λ⁻⁴ + A5 λ⁻⁶ + A6 λ⁻⁸ + A7 λ⁻¹⁰ + A8 λ⁻¹²`

添付xlsxの係数値を検算すると、9項多項式は`n²`を表し、評価結果の平方根が屈折率`n`になります。例えば`J-FK5`ではd線で`nd=1.48749`を再現します。co-optではこの平方根を含むHIKARI式を実装し、`data/hikari_catalog.ts`の155件へ適用しました。

旧 Angle state を primary wavelength `0.550 um` で再取得した Field ごとの reference sphere geometry は次のとおりです。全 Field で `center x=0`, `center z=53.192 mm`, `direction x=0`, `direction z=-32.266692 mm`, `exit x=0`, `exit z=20.926 mm` です。表示 mode は geometry に影響しないため、この表は `wav` の raw 実行から取得しています。

| Field | Field angle y (deg) | Sphere center y (mm) | Radius (mm) | Direction y (mm) | Exit intersection y (mm) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 0.000000 | 0.000 | 32.266692 | 0.000000 | 0.000 |
| 2 | 3.282822 | 2.009 | 32.329262 | -2.010421 | -0.001 |
| 3 | 6.557914 | 4.029 | 32.518584 | -4.039664 | -0.011 |
| 4 | 9.775606 | 6.040 | 32.833647 | -6.075273 | -0.035 |
| 5 | 12.933936 | 8.052 | 33.274944 | -8.129114 | -0.077 |
| 6 | 16.030015 | 10.071 | 33.846013 | -10.218276 | -0.147 |
| 7 | 19.019649 | 12.079 | 34.543080 | -12.332272 | -0.253 |
| 8 | 21.904747 | 14.087 | 35.371182 | -14.490725 | -0.404 |
| 9 | 24.686094 | 16.101 | 36.336897 | -16.710197 | -0.609 |
| 10 | 27.322867 | 18.097 | 37.430804 | -18.971707 | -0.875 |
| 11 | 29.805915 | 20.070 | 38.653409 | -21.282543 | -1.212 |

Field 角の増加に伴い、sphere center、direction、radius、exit-pupil intersection が連続的に変化しています。したがって Field ごとの reference sphere geometry は実際に適用されています。旧診断の半径約 `50.150 mm` は exit-pupil position が `wav` request に渡っていない状態の値です。

### Field ごとの読み取り

| Field 群 | 観察 |
| --- | --- |
| 1 | piston が最も近い。raw は過大、defocus 除去は過小になる。 |
| 2 | 4 mode とも Optalix より低いが、raw が最も近い。 |
| 3 | raw がほぼ一致し、差は +0.00266。 |
| 4 | piston が最も近いが、約 -0.057 の差が残る。 |
| 5 | raw が最も近いが、約 -0.089 の差が残る。 |
| 6-8 | raw が最も近い。Field 6-7 は co-opt が低く、Field 8 はほぼ一致。 |
| 9 | piston が最も近い。raw は +0.254 と過大。 |
| 10 | piston が最も近い。defocus を除くと大きく低下する。 |
| 11 | scaled 0.895 が最も近い。ただし差は -0.088。Wavelength 3 単独では `0.30197` 対 `0.30207` と一致する。 |

`referenceSphereOpdGrid` は Rust 側で既に waves に変換済みです。co-opt の pooled 値は grid の値を再度 wavelength で割らずに集計しています。今回の比較では total の一致度ではなく、上表の Field ごとの傾向を優先します。

## 代表 cell 比較

| Cell | Optalix | co-opt raw | co-opt piston | co-opt piston+defocus | co-opt scaled 0.895 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Field 1 / Wavelength 1 | 0.03199 | 0.09752 | 0.03215 | 0.03212 | 0.03212 |
| Field 1 / Wavelength 2 | 0.15957 | 0.21417 | 0.12569 | 0.01318 | 0.02937 |
| Field 11 / Wavelength 2 | 0.72574 | 1.14404 | 0.66999 | 0.45673 | 0.46800 |
| Field 11 / Wavelength 3 | 0.30207 | 1.35322 | 0.67950 | 0.27275 | 0.30197 |

## Field 比較の結論

1. 全 Field に共通して Optalix と一致する単一の co-opt mode はない。
2. Field 3 と Field 8 は raw がよく一致する。特に Field 3 は差 `+0.00266`、Field 8 は `-0.00903` である。
3. Field 1, 4, 9, 10 は piston が最も近い。ただし Field 1 は defocus 除去の影響が大きく、Field 9-10 は raw が明確に過大である。
4. Field 11 は piston+defocus 系が近く、Wavelength 3 だけを見ると scaled 0.895 が Optalix とほぼ一致する。しかし Field 11 全体では `0.54510` 対 `0.63357` で、まだ過小である。
5. したがって、現在の差分は単一の defocus scale の問題ではなく、Field によって reference sphere、piston、defocus の寄与が異なる問題として扱う必要がある。

## 参照ファイル

- Optalix values: `diagnostics/fixtures/optalix-3g-images-87-03.json`
- co-opt values: `diagnostics/fixtures/coopt-cell-results.json`
- Latest cell comparison: `diagnostics/results/optalix-cell-compare-2026-07-13T08-29-49-419Z.json`
- Regression command: `npm run diag:optalix-regression`
- Comparison command: `npm run diag:optalix-compare -- --input diagnostics/fixtures/coopt-cell-results.json`

## HIKARI係数適用後のwav基準値

添付`HIKARI_ALL_Catalog_Data.xlsx`を適用し、fresh ImageHeight、grid 129、fixed entrance pupil、per-wavelength reference sphere、raw OPDで再実行した結果です。Pupil radiusは`5.937104 mm`、valid maskはField 1-8で全点、Field 9-11では周辺部のvignettingにより減少しています。

| Field | 0.475 um | 0.550 um | 0.625 um |
| ---: | ---: | ---: | ---: |
| 1 | 0.13257 | 0.17568 | 0.67712 |
| 2 | 0.71309 | 0.65628 | 0.93077 |
| 3 | 0.98408 | 0.88646 | 1.13067 |
| 4 | 0.86787 | 0.72046 | 0.99358 |
| 5 | 0.76436 | 0.52147 | 0.69888 |
| 6 | 0.84235 | 0.62049 | 0.52143 |
| 7 | 1.01113 | 0.87092 | 0.63228 |
| 8 | 1.13927 | 1.08174 | 0.82944 |
| 9 | 1.18333 | 1.26323 | 1.08126 |
| 10 | 1.15870 | 1.38098 | 1.32859 |
| 11 | 1.33518 | 1.18773 | 1.29818 |

Individual-cell RMSは`0.93117 waves`、valid-sample-weighted RMSは`0.92917 waves`でした。Field 1の長波長側増加と、Field 6-8の短波長側増加が同時に存在するため、残差はHIKARI分散の単純な全体倍率では説明できません。次の切り分けは、同じ係数・同じFieldで`per-wavelength sphere`と`primary sphere`を比較し、chromatic focus/reference constructionの寄与を分離することです。

同一条件で`primary-wavelength`へ切り替えたA/Bでは、Individual-cell RMSが`0.93118 waves`、valid-sample-weighted RMSが`0.92918 waves`となり、per-wavelengthとの差は約`1e-5 waves`でした。各Field・各波長のRMSも表示桁で一致しています。したがって、現在の実装ではreference sphereの波長選択は残差の主因ではなく、次はchromatic focusまたはOptalix側のimage-point定義を調べます。

同じprimary sphere、fixed pupil=`5.937104 mm`でimage pointを比較しました。再測定時の`chief-ray-image-point`と`paraxial-image-point`は、全11 Field・全3波長でRMS、piston、defocus、sphere geometryまで完全一致し、Individual-cell RMSはいずれも`0.93117 waves`でした。この系ではparaxial pointがchief rayの横位置を同じtarget surface planeへ投影するだけで、実効的なimage point差がありません。以前記録した`0.91550 waves`のparaxial値は、image point差の根拠としては無効であり、別実行時の状態差または条件差として扱います。

`target-surface-center`はoff-axis Field 2以降で`288..1751 waves`級まで発散し、全体RMSも`1137.86 waves`となりました。このモードは共通の画像面中心を使うため、今回のOptalix比較候補から除外します。次の候補はchief/paraxialの差を含むchromatic focusと、Optalixが像点をchief rayまたはparaxial rayのどちらから決めているかです。

さらにfixed pupilで`per-wavelength-best-focus-point`を測定すると、Individual-cell RMS=`0.91564 waves`、valid-sample-weighted RMS=`0.91646 waves`、pooled reference-ray RMS=`0.80337 waves`となりました。chiefの`0.93117 waves`よりは低いものの、best-focusではField 8/W2のdefocusがchiefの`+0.984213 waves`から`-1.944215 waves`へ変化し、reference sphere centerも変化しています。このためbest-focusモードはfocusだけでなくreference sphere geometryも同時に変更しており、現状のRMS差をfocus単独の効果とは判定できません。Optalix比較では、まずreference sphere geometryを固定したままimage planeだけを動かす試験が必要です。

### Fixed reference sphere による image point A/B

Fieldごとに primary wavelength の chief geometry（center、radius、unit direction）を取得し、3 wavelengthすべてへ注入して比較しました。`chief-fixed-sphere` と `per-wavelength-best-focus-fixed-sphere` の Field x wavelength RMS は表示桁で全て一致しました。代表値は次のとおりです。

| Field | Wavelength | chief fixed | best-focus fixed |
| ---: | ---: | ---: | ---: |
| 1 | 0.475 um | 0.13257 | 0.13257 |
| 2 | 0.475 um | 0.44264 | 0.44264 |
| 2 | 0.625 um | 1.02550 | 1.02550 |
| 5 | 0.475 um | 1.50338 | 1.50338 |
| 8 | 0.475 um | 2.24110 | 2.24110 |
| 11 | 0.625 um | 1.51523 | 1.51523 |

固定sphere側の合計は `Individual-cell RMS=1.10071 waves`、`valid-sample-weighted RMS=1.09843 waves`、`pooled reference-ray RMS=0.96289 waves` です。したがって、固定したreference sphereに対するimage point変更は、この系のRMS差の原因ではありません。

ログ中の`currentRmsUm`は、各image pointから再計算した未固定geometryの診断値です。固定sphere A/Bの判定には、表のRMSと`postRef`を使用します。例えばField 2/W1では、chief fixedとbest-focus fixedで`postRef=442.63876 waves`が一致する一方、`currentRmsUm`だけが変化します。

Optalix fixtureにはcell RMS以外のreference sphere geometryが保存されていないため、次の直接比較にはOptalix側のFieldごとのsphere center、exit-pupil intersection、radius、directionの出力が必要です。

### Exit pupil reference point A/B

Consoleに`exit=chief|center`指定を追加し、同一状態でreference pointだけを切り替えました。`exit=chief`はchief-rayとexit-pupil planeの交点、`exit=center`はexit-pupil centerを使います。Field 11ではgeometryが実際に変化し、chief-ray交点の`y=-1.543 mm`がcenter指定では`y=0.000 mm`になり、sphere radiusとdirectionも変わりました。

しかし、全Field・全wavelengthのRMSは表示桁で一致しました。

| Reference point | Individual-cell RMS | Valid-sample-weighted RMS | Pooled reference-ray RMS |
| --- | ---: | ---: | ---: |
| chief-ray intersection | 0.91550 | 0.91391 | 0.79842 |
| exit-pupil center | 0.91551 | 0.91392 | 0.79843 |

差は約`1e-5 waves`であり、exit-pupil reference point conventionも現在のOptalix差の主因ではありません。次は、reference sphere geometryではなく、Optalixとco-optのray-level OPDまたはglass dispersion評価を比較する必要があります。

### Optalix total の field weighting scan

Optalix fixtureの11 Field RMSからreported total `0.91718`を再現できるか、field-onlyの集計規則をscanしました。

| 集計規則 | Aggregate RMS | Optalix totalとの差 |
| --- | ---: | ---: |
| equal | 0.81616 | -0.10102 |
| image height | 0.85141 | -0.06577 |
| image height squared | 0.84317 | -0.07401 |
| annular area | 0.85140 | -0.06578 |
| edge emphasis | 0.83111 | -0.08607 |

自然なField重みだけでは`0.91718`を再現できません。Optalix totalは、表示cell RMSの単純なField集計ではなく、内部ray-level aggregate、非公開のField weight、またはcell表示値とは異なるサンプル集合を使っている可能性があります。したがって、以降はtotalではなくField x wavelength cellとray-level OPD段階を優先して比較します。

### Native HIKARI dispersion path の確認

ZMXで使用されている6 glass（`J-LASFH22`, `J-SF13`, `J-LASF08A`, `J-LF7`, `J-SF2`, `J-LASFH9A`）をcatalog lookupで確認しました。いずれも重複なしでHIKARI catalogへ解決され、0.475 / 0.550 / 0.625 umで9項式から屈折率を評価しています。

| Glass | n(0.475 um) | n(0.550 um) | n(0.625 um) |
| --- | ---: | ---: | ---: |
| J-LASFH22 | 1.864179856 | 1.852626490 | 1.845115685 |
| J-SF13 | 1.762808305 | 1.746401144 | 1.736235760 |
| J-LASF08A | 1.900607883 | 1.887616655 | 1.879223924 |
| J-LF7 | 1.586275125 | 1.577949632 | 1.572607660 |
| J-SF2 | 1.663431246 | 1.651753022 | 1.644395653 |
| J-LASFH9A | 1.923250507 | 1.908002145 | 1.898297389 |

Browser/WASM native requestでは、TypeScript側で波長ごとに解決した`__cooptResolvedRindex`をRustが最優先で使用します。そのため、今回の波長別符号反転は、co-optがnd/Vd近似へfallbackした結果ではありません。Optalix側catalogの係数・補間規則、またはray-level OPD集計を直接比較する段階へ進みます。

### JS / Rust-WASM OPD parity

co-opt内部のbackend差を除外するため、同一条件でJavaScript ray traceとRust-WASM ray traceのOPD mapを比較しました。`12820` valid samplesで、OPD umおよびOPD wavesのmax、mean、RMS差はすべて`0`でした。

したがって、現在のOptalix差はco-optのJS/WASM実装分岐では説明できません。残差はOptalix側のcatalog係数・補間、reference construction、pupil sample集合、またはray-level RMS集計のいずれかに限定されます。

### Primary ImageHeight angle固定 A/B

Primary `0.550 um`で解いたImageHeight field angleだけを3波長で固定し、stop-center chiefのoriginとdirectionは各波長で再構築しました。runtime angleは全Fieldの3波長で一致し、Field 11ではすべて`31.673493 deg`でした。

しかし、piston-only 33-cell比較はW1 MAE=`0.81992 waves`、W2 MAE=`0.00344 waves`、W3 MAE=`0.36908 waves`でした。直前値はそれぞれ約`0.82034 / 0.00315 / 0.36929 waves`であり、W1/W3の改善は`0.0005 waves`未満、W2はわずかに悪化しました。Individual-cell RMSも`0.94033`から`0.94016 waves`への微小変化に留まりました。

したがって、primary ImageHeight angle固定はchromatic WAV差の主因ではありません。専用の`freezeImageHeightFieldAngle`経路は削除し、derived entrance pupilとruntime ImageHeight診断だけを維持します。

## 2026-07-14: attached OTX direct capture

起動中のOpTaliX V12.70で`\\SynologyNAS\Temp\lens_data\3G_IMAGE_F35_FNO_2.2_87_03.otx`を直接照会した。bare `WAV`の代表値はField 1が`0.03194 / 0.15866 / 0.16727`、Field 6が`0.42446 / 1.02767 / 0.52679`、Field 11が`0.41579 / 0.73617 / 0.30397`だった。既存fixtureとの差は光学状態の微差であり、以後はこのactive OTX値を比較対象とする。

`IND`出力とattached JSONを比較した結果、全glass、全3波長の屈折率は小数9桁まで一致した。catalog/private-glass係数差はW1/W3不一致の原因ではない。

OpTaliX lens databaseの`Y/Z/CY/CZ`とco-opt native `chiefSurfaceTrace`を全surfaceで比較した。ImageHeight field angleはprimary wavelengthでnative solveし、そのdirectionを全波長で共有しつつ、各波長でoriginだけstop centerへaimする必要がある。この変更後、Field 6 chief rayのOpTaliXとの差はfirst surfaceで約`3.7e-6 mm`以下、image surfaceで約`1.3e-6 mm`以下、stopで約`1e-7 mm`となった。

chief ray parity後もgrid 129 piston RMSはField 6が`1.260751 / 1.028663 / 0.817019`、Field 11が`1.702716 / 0.717674 / 0.581245`で、W1/W3はほぼ未改善だった。chief-ray wavelength re-aimは実在するsemantics差だったが、WAV RMS差の主因ではない。

Field 6、relative pupil `(0.75, 0)`のmarginal rayはsurface 1からOpTaliXとずれる。co-optはfirst-surface sagが約`0.036 mm`大きく、ray heightが外側にある。単純な`stop` samplingへの変更はW2を`0.999 -> 0.827`まで悪化させたため棄却した。次の比較対象は、OpTaliX relative-pupil座標から実ray launchを作るmappingであり、reference sphereやglass indexではない。

### Exact sagittal pupil mapping

OpTaliXのrelative pupil `(0.75, 0)`は、Field 6のstop面で全波長とも`X=5.1002 mm`付近を通る。attached JSONのstop semidiameterは`6.8 mm`であり、これは`0.75 * 6.8 = 5.1 mm`と一致する。co-optの対応座標は`u=-0.75, v=0`であるため、infinite-conjugate pupil basisの向きをstop local basisへ変換し、固定field directionのままoriginを物理stop座標へaimした。

このrayは全16面でOpTaliXと一致し、3波長のposition RMSは`0.000105..0.000118 mm`、direction RMSは約`3e-6`だった。したがって、少なくともsagittal axisではOpTaliXのrelative pupil mappingを再現できた。

しかしgrid 17のpiston RMSは、entrance baselineからstop-aimed mappingへ変更してもField 6で`1.19372 / 0.99913 / 0.79370`から`1.25589 / 1.00990 / 0.79179`へ変化するだけで、active OpTaliXの`0.42446 / 1.02767 / 0.52679`には近づかなかった。W2もわずかに悪化するためproduction defaultには採用しない。first-surface marginal offsetは実在するが、W1/W3 WAV残差の主因ではない。次はmeridional relative-pupil rayを直接取得するか、pupil mappingから独立したray-level OPD conventionを比較する。
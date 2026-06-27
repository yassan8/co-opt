// test-toric-paraxial.js
// トーリック面の近軸計算テスト

import { calculateFocalLength, calculateBackFocalLength, calculateFullSystemParaxialTraceWithToric } from '../raytracing/core/ray-paraxial.ts';

/**
 * トーリック面を含む簡単な光学系のテスト
 */
function testToricParaxial() {
  console.log('=== トーリック面近軸計算テスト ===\n');
  
  // テストシステム: Object - トーリックレンズ - Image
  const opticalSystem = [
    {
      id: 0,
      "object type": "Object",
      surfType: "",
      radius: "INF",
      thickness: "INF",
      semidia: 10,
      material: "",
      rindex: 1,
      abbe: ""
    },
    {
      id: 1,
      "object type": "",
      surfType: "Toric",
      radiusX: 50,      // Tangential radius (X方向)
      radiusY: 100,     // Sagittal radius (Y方向)
      conic: 0,
      axis: 0,
      thickness: 5,
      semidia: 10,
      material: "N-BK7",
      rindex: 1.5168,
      abbe: 64.17
    },
    {
      id: 2,
      "object type": "",
      surfType: "Toric",
      radiusX: -50,
      radiusY: -100,
      conic: 0,
      axis: 0,
      thickness: 100,
      semidia: 10,
      material: "",
      rindex: 1,
      abbe: ""
    },
    {
      id: 3,
      "object type": "Image",
      surfType: "",
      radius: "INF",
      thickness: 0,
      semidia: 10,
      material: "",
      rindex: 1,
      abbe: ""
    }
  ];
  
  // 近軸計算実行
  const result = calculateFullSystemParaxialTraceWithToric(opticalSystem, 0.5875618);
  
  if (!result) {
    console.error('❌ 近軸計算に失敗しました');
    return;
  }
  
  console.log('トーリック面検出:', result.hasToric ? 'Yes' : 'No');
  console.log('');
  
  if (result.hasToric) {
    console.log('【タンジェンシャル方向 (X軸, radiusX使用)】');
    console.log(`  焦点距離 (EFL): ${result.tangential.focalLength?.toFixed(6)} mm`);
    console.log(`  バックフォーカス (BFL): ${result.tangential.backFocalLength?.toFixed(6)} mm`);
    console.log(`  像面距離: ${result.tangential.imageDistance?.toFixed(6)} mm`);
    console.log('');
    
    console.log('【サジタル方向 (Y軸, radiusY使用)】');
    console.log(`  焦点距離 (EFL): ${result.sagittal.focalLength?.toFixed(6)} mm`);
    console.log(`  バックフォーカス (BFL): ${result.sagittal.backFocalLength?.toFixed(6)} mm`);
    console.log(`  像面距離: ${result.sagittal.imageDistance?.toFixed(6)} mm`);
    console.log('');
    
    console.log('【非点収差】');
    console.log(`  焦点距離の差: ${result.astigmatism.toFixed(6)} mm`);
    console.log(`  (タンジェンシャル焦点 - サジタル焦点)`);
    console.log('');
    
    console.log('【平均値（参考）】');
    console.log(`  平均焦点距離: ${result.focalLength?.toFixed(6)} mm`);
    console.log(`  平均バックフォーカス: ${result.backFocalLength?.toFixed(6)} mm`);
  } else {
    console.log('焦点距離 (EFL):', result.focalLength?.toFixed(6), 'mm');
    console.log('バックフォーカス (BFL):', result.backFocalLength?.toFixed(6), 'mm');
    console.log('像面距離:', result.imageDistance?.toFixed(6), 'mm');
  }
  
  console.log('\n=== calculateFocalLength() の結果 ===');
  const focalLengthResult = calculateFocalLength(opticalSystem, 0.5875618);
  if (typeof focalLengthResult === 'object') {
    console.log('タンジェンシャル焦点距離:', focalLengthResult.tangential?.toFixed(6), 'mm');
    console.log('サジタル焦点距離:', focalLengthResult.sagittal?.toFixed(6), 'mm');
    console.log('平均焦点距離:', focalLengthResult.average?.toFixed(6), 'mm');
    console.log('非点収差:', focalLengthResult.astigmatism?.toFixed(6), 'mm');
  } else {
    console.log('焦点距離:', focalLengthResult?.toFixed(6), 'mm');
  }
  
  console.log('\n✅ テスト完了');
}

// ブラウザ環境での実行
if (typeof window !== 'undefined') {
  window['testToricParaxial'] = testToricParaxial;
  console.log('トーリック面近軸計算テストをロードしました');
  console.log('実行するには: testToricParaxial()');
}

// Node.js環境での実行
if (typeof module !== 'undefined' && module.exports) {
  testToricParaxial();
}

export { testToricParaxial };

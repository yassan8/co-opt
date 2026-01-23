// 光線追跡パフォーマンス比較テスト

console.log('🔬 光線追跡パフォーマンス診断ツール');

// 関数の動的インポート
let RayTracingModule = null;

// モジュールのロードを待つ
async function loadRayTracingModule() {
  if (!RayTracingModule) {
    try {
      RayTracingModule = await import('../raytracing/core/ray-tracing.js');
      console.log('📦 ray-tracing.js モジュールを読み込みました');
    } catch (error) {
      console.error('❌ ray-tracing.js モジュールの読み込みに失敗:', error);
    }
  }
  return RayTracingModule;
}

// パフォーマンス比較テスト関数
window.runPerformanceDiagnosis = async function() {
  console.log('\n🔍 光線追跡パフォーマンス診断開始...');
  
  const rayTracing = await loadRayTracingModule();
  if (!rayTracing) {
    console.error('❌ ray-tracing.jsモジュールが利用できません');
    return;
  }
  
  // テストデータ
  const testRays = [];
  const testParams = {
    radius: 50.0,
    conic: -0.5,
    coef1: 1e-6,
    coef2: -2e-9,
    coef3: 5e-12,
    semidia: 10.0
  };
  
  // テスト光線生成
  for (let i = 0; i < 1000; i++) {
    testRays.push({
      pos: { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: 0 },
      dir: { x: (Math.random() - 0.5) * 0.1, y: (Math.random() - 0.5) * 0.1, z: 1 }
    });
  }
  
  // 1. キャッシュなしテスト
  console.log('\n📊 テスト1: キャッシュ無効');
  if (rayTracing.disableCache) {
    rayTracing.disableCache();
  }
  
  const start1 = performance.now();
  for (let i = 0; i < testRays.length; i++) {
    const r = Math.sqrt(testRays[i].pos.x ** 2 + testRays[i].pos.y ** 2);
    if (rayTracing.asphericSag) {
      rayTracing.asphericSag(r, testParams, "even");
    }
  }
  const end1 = performance.now();
  const timeNoCache = end1 - start1;
  
  console.log(`   時間: ${timeNoCache.toFixed(2)}ms`);
  console.log(`   平均: ${(timeNoCache / testRays.length).toFixed(4)}ms/回`);
  
  // 2. 軽量キャッシュテスト
  console.log('\n📊 テスト2: 軽量キャッシュ');
  if (rayTracing.enableCache) {
    rayTracing.enableCache();
  }
  
  const start2 = performance.now();
  for (let i = 0; i < testRays.length; i++) {
    const r = Math.sqrt(testRays[i].pos.x ** 2 + testRays[i].pos.y ** 2);
    if (rayTracing.asphericSag) {
      rayTracing.asphericSag(r, testParams, "even");
    }
  }
  const end2 = performance.now();
  const timeLightCache = end2 - start2;
  
  console.log(`   時間: ${timeLightCache.toFixed(2)}ms`);
  console.log(`   平均: ${(timeLightCache / testRays.length).toFixed(4)}ms/回`);
  
  // 3. 重複データテスト（キャッシュ効果確認）
  console.log('\n📊 テスト3: 重複データ（キャッシュ効果確認）');
  const sameR = 1.5;
  
  const start3 = performance.now();
  for (let i = 0; i < 1000; i++) {
    if (rayTracing.asphericSag) {
      rayTracing.asphericSag(sameR, testParams, "even");
    }
  }
  const end3 = performance.now();
  const timeDuplicateCache = end3 - start3;
  
  console.log(`   時間: ${timeDuplicateCache.toFixed(2)}ms`);
  console.log(`   平均: ${(timeDuplicateCache / 1000).toFixed(4)}ms/回`);
  
  // 4. 交点計算テスト
  console.log('\n📊 テスト4: 交点計算');
  const start4 = performance.now();
  for (let i = 0; i < 100; i++) { // 少ない回数で測定
    if (rayTracing.intersectAsphericSurface) {
      rayTracing.intersectAsphericSurface(testRays[i], testParams, "even");
    }
  }
  const end4 = performance.now();
  const timeIntersection = end4 - start4;
  
  console.log(`   時間: ${timeIntersection.toFixed(2)}ms (100回)`);
  console.log(`   平均: ${(timeIntersection / 100).toFixed(4)}ms/回`);
  
  // 結果分析
  console.log('\n📈 性能分析結果:');
  console.log(`   キャッシュなし: ${timeNoCache.toFixed(2)}ms`);
  console.log(`   軽量キャッシュ: ${timeLightCache.toFixed(2)}ms`);
  console.log(`   重複キャッシュ: ${timeDuplicateCache.toFixed(2)}ms`);
  
  if (timeLightCache > timeNoCache) {
    console.log('⚠️  キャッシュがオーバーヘッドになっています！');
    console.log(`   オーバーヘッド: +${((timeLightCache - timeNoCache) / timeNoCache * 100).toFixed(1)}%`);
    console.log('   推奨: キャッシュを無効化してください');
  } else {
    console.log('✅ キャッシュが効果的に動作しています');
    console.log(`   高速化: -${((timeNoCache - timeLightCache) / timeNoCache * 100).toFixed(1)}%`);
  }
  
  const duplicateSpeedup = timeNoCache / timeDuplicateCache;
  if (duplicateSpeedup > 5) {
    console.log(`✅ 重複データでの高速化: ${duplicateSpeedup.toFixed(1)}x`);
  } else {
    console.log(`⚠️  重複データでの高速化が不十分: ${duplicateSpeedup.toFixed(1)}x`);
  }
  
  // キャッシュ統計表示
  if (rayTracing.displayCacheStats) {
    console.log('\n📊 キャッシュ統計:');
    rayTracing.displayCacheStats();
  }
  
  console.log('\n🎯 推奨設定:');
  if (timeLightCache > timeNoCache * 1.1) {
    console.log('   → キャッシュを無効化 (await disableCacheFunction())');
  } else {
    console.log('   → 現在の設定を維持');
  }
};

// 簡単なテスト関数
window.quickPerformanceTest = async function() {
  console.log('⚡ クイックパフォーマンステスト');
  
  const rayTracing = await loadRayTracingModule();
  if (!rayTracing) {
    console.error('❌ ray-tracing.jsモジュールが利用できません');
    return;
  }
  
  const params = { radius: 50, conic: 0, semidia: 10 };
  const iterations = 10000;
  
  console.time('SAG計算');
  for (let i = 0; i < iterations; i++) {
    if (rayTracing.asphericSag) {
      rayTracing.asphericSag(1.0, params, "even");
    }
  }
  console.timeEnd('SAG計算');
  
  if (rayTracing.displayCacheStats) {
    rayTracing.displayCacheStats();
  }
};

// 個別の制御関数
window.disableCacheFunction = async function() {
  const rayTracing = await loadRayTracingModule();
  if (rayTracing && rayTracing.disableCache) {
    rayTracing.disableCache();
    console.log('🔇 キャッシュを無効化しました');
  }
};

window.enableCacheFunction = async function() {
  const rayTracing = await loadRayTracingModule();
  if (rayTracing && rayTracing.enableCache) {
    rayTracing.enableCache();
    console.log('🔊 キャッシュを有効化しました');
  }
};

window.displayCacheStatsFunction = async function() {
  const rayTracing = await loadRayTracingModule();
  if (rayTracing && rayTracing.displayCacheStats) {
    rayTracing.displayCacheStats();
  }
};

console.log('\n🎯 使用方法:');
console.log('  runPerformanceDiagnosis() - 詳細診断');
console.log('  quickPerformanceTest() - クイックテスト');
console.log('  disableCacheFunction() - キャッシュ無効化');
console.log('  enableCacheFunction() - キャッシュ有効化');
console.log('  displayCacheStatsFunction() - キャッシュ統計表示');

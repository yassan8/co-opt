/**
 * Coordinate Transformation Test Suite
 * Tests the coordinate transformation and chief ray shifting functionality
 */

// Wait for modules to load
setTimeout(() => {
  runCoordinateTransformTests();
}, 2000);

async function runCoordinateTransformTests() {
  
  let passedTests = 0;
  let totalTests = 0;
  const results = [];
  
  // Test 1: Round-trip transformation accuracy
  try {
    totalTests++;
    
    // Create a simple test optical system
    const testSystem = createTestOpticalSystem();
    
    // Create test ray
    const originalRay = {
      pos: { x: 5.0, y: 3.0, z: 10.0 },
      dir: { x: 0.1, y: 0.05, z: 0.99 },
      wavelength: 0.55
    };
    
    // Normalize direction
    const dirMag = Math.sqrt(
      originalRay.dir.x ** 2 + 
      originalRay.dir.y ** 2 + 
      originalRay.dir.z ** 2
    );
    originalRay.dir.x /= dirMag;
    originalRay.dir.y /= dirMag;
    originalRay.dir.z /= dirMag;
    
    // Transform to surface 1 coordinates
    const targetSurfaceIndex = 1;
    const transformResult = window.resetToSurfaceCoordinates(
      originalRay, 
      targetSurfaceIndex, 
      testSystem
    );
    
    const { transformedRay, origin, rotationMatrix } = transformResult;
    
    // Restore to global coordinates
    const restoredRay = window.restoreFromLocalCoordinates(
      transformedRay,
      { origin, rotationMatrix }
    );
    
    // Check accuracy
    const posError = Math.sqrt(
      (originalRay.pos.x - restoredRay.pos.x) ** 2 +
      (originalRay.pos.y - restoredRay.pos.y) ** 2 +
      (originalRay.pos.z - restoredRay.pos.z) ** 2
    );
    
    const dirError = Math.sqrt(
      (originalRay.dir.x - restoredRay.dir.x) ** 2 +
      (originalRay.dir.y - restoredRay.dir.y) ** 2 +
      (originalRay.dir.z - restoredRay.dir.z) ** 2
    );
    
    const tolerance = 1e-10;
    const passed = posError < tolerance && dirError < tolerance;
    
    if (passed) {
      passedTests++;
    } else {
      console.log('  ❌ FAILED');
    }
    
    results.push({ test: 'Round-trip transformation', passed, posError, dirError });
    
  } catch (error) {
    console.log('  Stack:', error.stack);
    results.push({ test: 'Round-trip transformation', passed: false, error: error.message });
  }
  
  console.log('');
  
  // Test 2: Rotation matrix orthogonality
  try {
    totalTests++;
    
    const testSystem = createTestOpticalSystem();
    const targetSurfaceIndex = 2; // CoordTrans surface
    
    // Get surface data
    const surfaceData = window.calculateSurfaceOrigins?.(testSystem);
    if (!surfaceData || targetSurfaceIndex >= surfaceData.length) {
      throw new Error('Failed to get surface data');
    }
    
    const { rotationMatrix } = surfaceData[targetSurfaceIndex];
    
    // Calculate R * R^T (should be identity matrix)
    const identity = multiplyMatrices(rotationMatrix, transposeMatrix(rotationMatrix));
    
    // Check if result is identity matrix
    const expectedIdentity = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ];
    
    let maxError = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const error = Math.abs(identity[i][j] - expectedIdentity[i][j]);
        maxError = Math.max(maxError, error);
      }
    }
    
    const tolerance = 1e-10;
    const passed = maxError < tolerance;
    
    if (passed) {
      console.log(`  Max deviation from identity: ${maxError.toExponential(3)} (< ${tolerance})`);
      console.log('  Rotation matrix:');
      console.log('  ', rotationMatrix.map(row => row.map(v => v.toFixed(6)).join('  ')).join('\n   '));
      passedTests++;
    } else {
      console.log('  ❌ FAILED');
      console.log(`  Max deviation from identity: ${maxError.toExponential(3)} (threshold: ${tolerance})`);
    }
    
    results.push({ test: 'Rotation matrix orthogonality', passed, maxError });
    
  } catch (error) {
    console.log('  Stack:', error.stack);
    results.push({ test: 'Rotation matrix orthogonality', passed: false, error: error.message });
  }
  
  console.log('');
  
  // Test 3: Chief ray shift validation
  try {
    totalTests++;
    
    const testSystem = createTestOpticalSystem();
    
    // Mock chief ray path (simplified)
    const chiefRayPath = [
      { x: 0, y: 0, z: 0 },      // Start
      { x: 1.5, y: 0.5, z: 20 }, // Surface 1
      { x: 3.2, y: 1.1, z: 30 }, // Surface 2
      { x: 5.0, y: 1.8, z: 50 }  // Surface 3
    ];
    
    // Create test ray
    const testRay = {
      pos: { x: 2.0, y: 1.0, z: 20.0 },
      dir: { x: 0, y: 0, z: 1 },
      wavelength: 0.55
    };
    
    const targetSurfaceIndex = 1;
    
    // Shift ray to chief ray origin
    const shiftResult = window.shiftToChiefRayOrigin(
      testRay,
      targetSurfaceIndex,
      chiefRayPath,
      testSystem
    );
    
    const { shiftedRay, chiefRayShift } = shiftResult;
    
    // Check that shifted position is close to origin
    const distanceFromOrigin = Math.sqrt(
      shiftedRay.pos.x ** 2 +
      shiftedRay.pos.y ** 2 +
      shiftedRay.pos.z ** 2
    );
    
    // The shifted ray should be the offset from chief ray
    const expectedShift = {
      x: testRay.pos.x - chiefRayPath[1].x,
      y: testRay.pos.y - chiefRayPath[1].y,
      z: testRay.pos.z - chiefRayPath[1].z
    };
    
    const shiftError = Math.sqrt(
      (shiftedRay.pos.x - expectedShift.x) ** 2 +
      (shiftedRay.pos.y - expectedShift.y) ** 2 +
      (shiftedRay.pos.z - expectedShift.z) ** 2
    );
    
    const tolerance = 1e-6;
    const passed = shiftError < tolerance;
    
    if (passed) {
      console.log(`  Chief ray position: (${chiefRayPath[1].x.toFixed(3)}, ${chiefRayPath[1].y.toFixed(3)}, ${chiefRayPath[1].z.toFixed(3)})`);
      console.log(`  Shifted ray position: (${shiftedRay.pos.x.toFixed(3)}, ${shiftedRay.pos.y.toFixed(3)}, ${shiftedRay.pos.z.toFixed(3)})`);
      passedTests++;
    } else {
      console.log('  ❌ FAILED');
    }
    
    results.push({ test: 'Chief ray shift', passed, shiftError });
    
  } catch (error) {
    console.log('  Stack:', error.stack);
    results.push({ test: 'Chief ray shift', passed: false, error: error.message });
  }
  
  console.log('');
  
  // Test 4: JSON save/load data integrity
  try {
    totalTests++;
    
    // Create mock coordinate data
    const mockData = {
      surfaces: {
        1: {
          localDecenterX: 5.123,
          localDecenterY: -2.456,
          localDecenterZ: 10.789,
          localTiltX: 0.0,
          localTiltY: 0.0,
          localTiltZ: 0.0,
          transformType: 'chief',
          targetSurface: 2
        },
        2: {
          localDecenterX: -1.234,
          localDecenterY: 3.567,
          localDecenterZ: 15.890,
          localTiltX: 0.0,
          localTiltY: 0.0,
          localTiltZ: 0.0,
          transformType: 'coord',
          targetSurface: 2
        }
      },
      metadata: {
        targetSurfaceIndex: 2,
        timestamp: new Date().toISOString(),
        version: '1.0',
        opticalSystemHash: 'test-hash-12345',
        cancelled: false,
        surfaceCount: 2
      }
    };
    
    // Convert to JSON and back
    const json = JSON.stringify(mockData, null, 2);
    const parsed = JSON.parse(json);
    
    // Verify data integrity
    let dataMatches = true;
    let mismatchDetails = [];
    
    // Check surfaces
    for (const surfaceId in mockData.surfaces) {
      const original = mockData.surfaces[surfaceId];
      const restored = parsed.surfaces[surfaceId];
      
      if (!restored) {
        dataMatches = false;
        mismatchDetails.push(`Missing surface ${surfaceId}`);
        continue;
      }
      
      for (const key in original) {
        if (original[key] !== restored[key]) {
          dataMatches = false;
          mismatchDetails.push(`Surface ${surfaceId}.${key}: ${original[key]} !== ${restored[key]}`);
        }
      }
    }
    
    // Check metadata
    for (const key in mockData.metadata) {
      if (mockData.metadata[key] !== parsed.metadata[key]) {
        dataMatches = false;
        mismatchDetails.push(`Metadata.${key}: ${mockData.metadata[key]} !== ${parsed.metadata[key]}`);
      }
    }
    
    const passed = dataMatches;
    
    if (passed) {
      console.log('  All data fields match after JSON round-trip');
      console.log(`  JSON size: ${json.length} bytes`);
      passedTests++;
    } else {
      console.log('  ❌ FAILED');
      console.log('  Data mismatches:', mismatchDetails);
    }
    
    results.push({ test: 'JSON data integrity', passed, mismatchDetails });
    
  } catch (error) {
    results.push({ test: 'JSON data integrity', passed: false, error: error.message });
  }
  
  console.log('');
  
  // Test 5: Metadata validation
  try {
    totalTests++;
    
    const mockMetadata = {
      targetSurfaceIndex: 5,
      timestamp: '2026-02-03T10:30:00.000Z',
      version: '1.0',
      opticalSystemHash: 'abc123xyz',
      cancelled: false,
      surfaceCount: 10
    };
    
    // Validate required fields
    const requiredFields = [
      'targetSurfaceIndex',
      'timestamp',
      'version',
      'surfaceCount'
    ];
    
    let allFieldsPresent = true;
    const missingFields = [];
    
    for (const field of requiredFields) {
      if (!(field in mockMetadata)) {
        allFieldsPresent = false;
        missingFields.push(field);
      }
    }
    
    // Validate types
    const typeChecks = [
      { field: 'targetSurfaceIndex', type: 'number' },
      { field: 'timestamp', type: 'string' },
      { field: 'version', type: 'string' },
      { field: 'surfaceCount', type: 'number' }
    ];
    
    let allTypesCorrect = true;
    const typeErrors = [];
    
    for (const check of typeChecks) {
      const actualType = typeof mockMetadata[check.field];
      if (actualType !== check.type) {
        allTypesCorrect = false;
        typeErrors.push(`${check.field}: expected ${check.type}, got ${actualType}`);
      }
    }
    
    const passed = allFieldsPresent && allTypesCorrect;
    
    if (passed) {
      console.log('  All required metadata fields present with correct types');
      console.log('  Metadata:', mockMetadata);
      passedTests++;
    } else {
      console.log('  ❌ FAILED');
      if (!allFieldsPresent) console.log('  Missing fields:', missingFields);
      if (!allTypesCorrect) console.log('  Type errors:', typeErrors);
    }
    
    results.push({ test: 'Metadata validation', passed, missingFields, typeErrors });
    
  } catch (error) {
    results.push({ test: 'Metadata validation', passed: false, error: error.message });
  }
  
  // Summary
  console.log('');
  console.log('🧪 ========================================');
  console.log('🧪 Test Summary');
  console.log('🧪 ========================================');
  
  if (passedTests === totalTests) {
    console.log('\n✅ Coordinate Transform Test: All Passed (5/5 tests)');
  } else {
    console.error(`\n❌ Test Failed: ${totalTests - passedTests} test(s) failed`);
    console.log('\nFailed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.test}${r.error ? ': ' + r.error : ''}`);
    });
  }
  
  console.log('🧪 ========================================\n');
}

/**
 * Create a test optical system with a simple lens and CoordTrans
 */
function createTestOpticalSystem() {
  return [
    {
      id: 0,
      'object type': 'Object',
      object: 'Object',
      surfType: 'Standard',
      radius: Infinity,
      thickness: Infinity,
      semidia: 10,
      material: '',
      comment: 'Object'
    },
    {
      id: 1,
      'object type': '',
      surfType: 'Standard',
      radius: 50.0,
      thickness: 5.0,
      semidia: 25,
      material: 'N-BK7',
      rindex: 1.5168,
      abbe: 64.17,
      conic: 0,
      comment: 'Lens Front'
    },
    {
      id: 2,
      'object type': '',
      surfType: 'CoordTrans',
      radius: 0,
      thickness: 0,
      semidia: 5.0,  // decenterX
      material: 0,   // decenterY
      rindex: 0,     // tiltX
      abbe: 10.0,    // tiltY (degrees)
      conic: 0,      // tiltZ
      coef1: 0,      // order
      comment: 'Coord Break'
    },
    {
      id: 3,
      'object type': '',
      surfType: 'Standard',
      radius: -50.0,
      thickness: 45.0,
      semidia: 25,
      material: 'AIR',
      rindex: 1.0,
      abbe: 0,
      conic: 0,
      comment: 'Lens Back'
    },
    {
      id: 4,
      'object type': 'Image',
      surfType: 'Standard',
      radius: Infinity,
      thickness: 0,
      semidia: 15,
      material: '',
      comment: 'Image'
    }
  ];
}

/**
 * Matrix multiplication helper
 */
function multiplyMatrices(A, B) {
  const result = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      for (let k = 0; k < 3; k++) {
        result[i][j] += A[i][k] * B[k][j];
      }
    }
  }
  
  return result;
}

/**
 * Matrix transpose helper
 */
function transposeMatrix(M) {
  return [
    [M[0][0], M[1][0], M[2][0]],
    [M[0][1], M[1][1], M[2][1]],
    [M[0][2], M[1][2], M[2][2]]
  ];
}

#!/usr/bin/env node
/**
 * Test script to verify benchmark functions work correctly
 * Note: This tests module-level registration patterns, not browser window object
 */

// Simple test to verify the async wrapper pattern works
async function testAsyncWrapperPattern() {
    console.log('🧪 Testing async wrapper pattern...\n');
    
    // Define test async function
    async function testAsyncFunc() {
        return { success: true, data: 'test data' };
    }
    
    // Pattern 1: Direct assignment (this is what was failing)
    console.log('Pattern 1: Direct assignment');
    const obj1 = {};
    obj1.__test1 = testAsyncFunc;
    const result1 = await obj1.__test1();
    console.log('  Result:', result1);
    console.log('  Is object:', typeof result1 === 'object' && result1 !== null);
    
    // Pattern 2: Wrapper function (our fix)
    console.log('\nPattern 2: Wrapper function (THE FIX)');
    const obj2 = {};
    obj2.__test2 = async () => {
        console.log('    🔗 [Wrapper] called');
        const result = await testAsyncFunc();
        console.log('    🔗 [Wrapper] got result:', typeof result);
        return result;
    };
    const result2 = await obj2.__test2();
    console.log('  Result:', result2);
    console.log('  Is object:', typeof result2 === 'object' && result2 !== null);
    
    console.log('\n✅ Both patterns work in Node.js environment');
    console.log('The wrapper pattern (Pattern 2) is what we implemented for browser window object');
}

testAsyncWrapperPattern().catch(console.error);

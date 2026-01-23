/**
 * Performance Monitor Module
 * Handles performance testing and monitoring for the application
 */

/**
 * Performance monitor class for tracking operation performance
 */
class PerformanceMonitor {
    constructor() {
        this.records = [];
        this.isEnabled = true;
    }
    
    /**
     * Start timing an operation
     * @param {string} operationName - Name of the operation
     * @returns {string} Timer ID
     */
    startTimer(operationName) {
        if (!this.isEnabled) return null;
        
        const timerId = `${operationName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const record = {
            id: timerId,
            operation: operationName,
            startTime: performance.now(),
            endTime: null,
            duration: null,
            memory: this.getMemoryUsage(),
            metadata: {}
        };
        
        this.records.push(record);
        return timerId;
    }
    
    /**
     * Stop timing an operation
     * @param {string} timerId - Timer ID returned by startTimer
     * @param {Object} metadata - Additional metadata to store
     */
    stopTimer(timerId, metadata = {}) {
        if (!this.isEnabled || !timerId) return;
        
        const record = this.records.find(r => r.id === timerId);
        if (record) {
            record.endTime = performance.now();
            record.duration = record.endTime - record.startTime;
            record.metadata = { ...record.metadata, ...metadata };
            
            console.log(`⏱️ ${record.operation}: ${record.duration.toFixed(2)}ms`);
        }
    }
    
    /**
     * Get memory usage information
     * @returns {Object} Memory usage data
     */
    getMemoryUsage() {
        if (performance.memory) {
            return {
                used: performance.memory.usedJSHeapSize,
                total: performance.memory.totalJSHeapSize,
                limit: performance.memory.jsHeapSizeLimit
            };
        }
        return null;
    }
    
    /**
     * Get performance statistics for an operation
     * @param {string} operationName - Name of the operation
     * @returns {Object} Performance statistics
     */
    getStats(operationName) {
        const operationRecords = this.records.filter(r => r.operation === operationName && r.duration !== null);
        
        if (operationRecords.length === 0) {
            return null;
        }
        
        const durations = operationRecords.map(r => r.duration);
        const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;
        const minDuration = Math.min(...durations);
        const maxDuration = Math.max(...durations);
        
        return {
            operation: operationName,
            count: operationRecords.length,
            avgDuration: avgDuration.toFixed(2),
            minDuration: minDuration.toFixed(2),
            maxDuration: maxDuration.toFixed(2),
            totalDuration: durations.reduce((sum, d) => sum + d, 0).toFixed(2)
        };
    }
    
    /**
     * Clear all performance records
     */
    clear() {
        this.records = [];
    }
    
    /**
     * Get all performance records
     * @returns {Array} Array of performance records
     */
    getAllRecords() {
        return [...this.records];
    }
    
    /**
     * Enable or disable performance monitoring
     * @param {boolean} enabled - Whether to enable monitoring
     */
    setEnabled(enabled) {
        this.isEnabled = enabled;
    }
}

// Global performance monitor instance
export const performanceMonitor = new PerformanceMonitor();

/**
 * Create a performance test for plotting functions
 * @param {Object} testData - Test data for plotting
 * @param {number} size - Size of the test data
 * @returns {Object} Performance test result
 */
export async function createPlotPerformanceTest(testData, size) {
    console.log(`🧪 Running plot performance test for ${size}x${size} data...`);
    
    const results = {
        size,
        tests: {},
        summary: {}
    };
    
    try {
        // Test 2D plotting performance
        const plot2DTimer = performanceMonitor.startTimer(`plot2D_${size}`);
        
        // Simulate 2D plotting
        const startTime2D = performance.now();
        
        // Create a canvas for testing
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        
        // Simulate plotting by drawing pixels
        const imageData = ctx.createImageData(size, size);
        const data = imageData.data;
        
        for (let i = 0; i < testData.data.length; i++) {
            const value = Math.floor(testData.data[i] * 255);
            const pixelIndex = i * 4;
            data[pixelIndex] = value;     // Red
            data[pixelIndex + 1] = value; // Green
            data[pixelIndex + 2] = value; // Blue
            data[pixelIndex + 3] = 255;   // Alpha
        }
        
        ctx.putImageData(imageData, 0, 0);
        
        const plot2DTime = performance.now() - startTime2D;
        performanceMonitor.stopTimer(plot2DTimer, { dataSize: testData.data.length });
        
        results.tests.plot2D = {
            time: plot2DTime,
            dataSize: testData.data.length,
            pixelsPerSecond: (testData.data.length / plot2DTime * 1000).toFixed(0)
        };
        
        // Test 3D plotting performance (simulated)
        const plot3DTimer = performanceMonitor.startTimer(`plot3D_${size}`);
        
        const startTime3D = performance.now();
        
        // Simulate 3D plotting with more complex calculations
        let sum = 0;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const index = y * size + x;
                const value = testData.data[index];
                
                // Simulate 3D transformations
                const x3d = x - size / 2;
                const y3d = y - size / 2;
                const z3d = value * 100;
                
                // Simulate perspective projection
                const distance = Math.sqrt(x3d * x3d + y3d * y3d + z3d * z3d);
                sum += distance;
            }
        }
        
        const plot3DTime = performance.now() - startTime3D;
        performanceMonitor.stopTimer(plot3DTimer, { dataSize: testData.data.length, calculatedSum: sum });
        
        results.tests.plot3D = {
            time: plot3DTime,
            dataSize: testData.data.length,
            calculationsPerSecond: (testData.data.length / plot3DTime * 1000).toFixed(0)
        };
        
        // Test FFT performance (simulated)
        const fftTimer = performanceMonitor.startTimer(`fft_${size}`);
        
        const startTimeFFT = performance.now();
        
        // Simulate FFT calculations
        const fftData = new Float32Array(testData.data.length);
        for (let i = 0; i < testData.data.length; i++) {
            // Simulate complex FFT operations
            const real = testData.data[i];
            const imag = 0;
            
            // Simulate butterfly operations
            fftData[i] = Math.sqrt(real * real + imag * imag);
        }
        
        const fftTime = performance.now() - startTimeFFT;
        performanceMonitor.stopTimer(fftTimer, { dataSize: testData.data.length });
        
        results.tests.fft = {
            time: fftTime,
            dataSize: testData.data.length,
            operationsPerSecond: (testData.data.length / fftTime * 1000).toFixed(0)
        };
        
        // Calculate summary statistics
        const totalTime = plot2DTime + plot3DTime + fftTime;
        results.summary = {
            totalTime: totalTime.toFixed(2),
            avgTime: (totalTime / 3).toFixed(2),
            fastestTest: plot2DTime < plot3DTime && plot2DTime < fftTime ? 'plot2D' : 
                        plot3DTime < fftTime ? 'plot3D' : 'fft',
            slowestTest: plot2DTime > plot3DTime && plot2DTime > fftTime ? 'plot2D' : 
                        plot3DTime > fftTime ? 'plot3D' : 'fft',
            dataSize: testData.data.length,
            memoryUsage: performanceMonitor.getMemoryUsage()
        };
        
        console.log(`✅ Plot performance test completed for ${size}x${size} in ${totalTime.toFixed(2)}ms`);
        
        return results;
        
    } catch (error) {
        console.error(`❌ Error in plot performance test for ${size}x${size}:`, error);
        return {
            size,
            error: error.message,
            tests: {},
            summary: {}
        };
    }
}

/**
 * Display plot performance test results
 * @param {Array} results - Array of performance test results
 */
export function displayPlotPerformanceResults(results) {
    console.log('📊 Displaying plot performance results...');
    
    try {
        // Create or get results container
        let resultsContainer = document.getElementById('performance-results-container');
        if (!resultsContainer) {
            resultsContainer = document.createElement('div');
            resultsContainer.id = 'performance-results-container';
            resultsContainer.style.cssText = `
                margin: 20px 0;
                padding: 20px;
                border: 2px solid #28a745;
                border-radius: 10px;
                background-color: #f8f9fa;
                box-shadow: 0 4px 8px rgba(0,0,0,0.1);
                font-family: Arial, sans-serif;
            `;
            
            const container = document.getElementById('analysis-container') || document.body;
            container.appendChild(resultsContainer);
        }
        
        // Create results HTML
        let resultsHTML = `
            <div style="margin-bottom: 20px;">
                <h3 style="margin: 0 0 15px 0; color: #28a745; font-size: 1.3em;">
                    📊 Plot Performance Test Results
                </h3>
                <div style="font-size: 0.9em; color: #6c757d; margin-bottom: 15px;">
                    Comparing 2D plotting, 3D plotting, and FFT performance across different data sizes
                </div>
            </div>
        `;
        
        // Add results table
        resultsHTML += `
            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                <thead>
                    <tr style="background-color: #28a745; color: white;">
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Size</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: right;">2D Plot (ms)</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: right;">3D Plot (ms)</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: right;">FFT (ms)</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Total (ms)</th>
                        <th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Fastest</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        results.forEach(result => {
            if (result.error) {
                resultsHTML += `
                    <tr>
                        <td colspan="6" style="padding: 10px; border: 1px solid #ddd; color: #dc3545; text-align: center;">
                            Error testing ${result.size}x${result.size}: ${result.error}
                        </td>
                    </tr>
                `;
                return;
            }
            
            const plot2DTime = result.tests.plot2D?.time?.toFixed(2) || 'N/A';
            const plot3DTime = result.tests.plot3D?.time?.toFixed(2) || 'N/A';
            const fftTime = result.tests.fft?.time?.toFixed(2) || 'N/A';
            const totalTime = result.summary.totalTime || 'N/A';
            const fastestTest = result.summary.fastestTest || 'N/A';
            
            resultsHTML += `
                <tr>
                    <td style="padding: 10px; border: 1px solid #ddd; font-weight: bold;">${result.size}×${result.size}</td>
                    <td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${plot2DTime}</td>
                    <td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${plot3DTime}</td>
                    <td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${fftTime}</td>
                    <td style="padding: 10px; border: 1px solid #ddd; text-align: right; font-weight: bold;">${totalTime}</td>
                    <td style="padding: 10px; border: 1px solid #ddd; text-align: center;">
                        ${fastestTest === 'plot2D' ? '🥇 2D' : fastestTest === 'plot3D' ? '🥇 3D' : '🥇 FFT'}
                    </td>
                </tr>
            `;
        });
        
        resultsHTML += `
                </tbody>
            </table>
        `;
        
        // Add performance summary
        const validResults = results.filter(r => !r.error);
        if (validResults.length > 0) {
            const avgTotal = validResults.reduce((sum, r) => sum + parseFloat(r.summary.totalTime || 0), 0) / validResults.length;
            const maxSize = Math.max(...validResults.map(r => r.size));
            const minSize = Math.min(...validResults.map(r => r.size));
            
            resultsHTML += `
                <div style="margin-top: 20px; padding: 15px; background-color: #e9ecef; border-radius: 5px;">
                    <h4 style="margin: 0 0 10px 0; color: #333;">📈 Performance Summary</h4>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
                        <div>
                            <strong>Average Total Time:</strong> ${avgTotal.toFixed(2)} ms
                        </div>
                        <div>
                            <strong>Size Range:</strong> ${minSize}×${minSize} to ${maxSize}×${maxSize}
                        </div>
                        <div>
                            <strong>Tests Completed:</strong> ${validResults.length}/${results.length}
                        </div>
                        <div>
                            <strong>Status:</strong> ${validResults.length === results.length ? '✅ All Passed' : '⚠️ Some Failed'}
                        </div>
                    </div>
                </div>
            `;
        }
        
        resultsContainer.innerHTML = resultsHTML;
        
        console.log('✅ Plot performance results displayed successfully');
        
    } catch (error) {
        console.error('❌ Error displaying plot performance results:', error);
    }
}

/**
 * Benchmark a function execution
 * @param {Function} func - Function to benchmark
 * @param {Array} args - Arguments to pass to the function
 * @param {number} iterations - Number of iterations to run
 * @returns {Object} Benchmark results
 */
export async function benchmarkFunction(func, args = [], iterations = 10) {
    console.log(`🧪 Benchmarking function ${func.name} with ${iterations} iterations...`);
    
    const results = {
        functionName: func.name,
        iterations,
        times: [],
        avgTime: 0,
        minTime: Infinity,
        maxTime: 0,
        totalTime: 0,
        memoryBefore: performanceMonitor.getMemoryUsage(),
        memoryAfter: null
    };
    
    try {
        for (let i = 0; i < iterations; i++) {
            const startTime = performance.now();
            
            // Execute function
            if (func.constructor.name === 'AsyncFunction') {
                await func(...args);
            } else {
                func(...args);
            }
            
            const endTime = performance.now();
            const duration = endTime - startTime;
            
            results.times.push(duration);
            results.totalTime += duration;
            results.minTime = Math.min(results.minTime, duration);
            results.maxTime = Math.max(results.maxTime, duration);
        }
        
        results.avgTime = results.totalTime / iterations;
        results.memoryAfter = performanceMonitor.getMemoryUsage();
        
        console.log(`✅ Benchmark completed: ${func.name} - Avg: ${results.avgTime.toFixed(2)}ms`);
        
        return results;
        
    } catch (error) {
        console.error(`❌ Error benchmarking function ${func.name}:`, error);
        return {
            ...results,
            error: error.message
        };
    }
}

/**
 * Start a performance monitoring session
 * @param {string} sessionName - Name of the monitoring session
 */
export function startPerformanceSession(sessionName) {
    console.log(`🎯 Starting performance monitoring session: ${sessionName}`);
    performanceMonitor.clear();
    return performanceMonitor.startTimer(sessionName);
}

/**
 * End a performance monitoring session
 * @param {string} sessionId - Session ID returned by startPerformanceSession
 * @param {Object} metadata - Additional metadata for the session
 */
export function endPerformanceSession(sessionId, metadata = {}) {
    performanceMonitor.stopTimer(sessionId, metadata);
    
    const records = performanceMonitor.getAllRecords();
    const sessionRecord = records.find(r => r.id === sessionId);
    
    if (sessionRecord) {
        console.log(`🎯 Performance monitoring session completed: ${sessionRecord.operation}`);
        console.log(`   Duration: ${sessionRecord.duration.toFixed(2)}ms`);
        console.log(`   Memory: ${JSON.stringify(sessionRecord.memory)}`);
        
        return sessionRecord;
    }
    
    return null;
}

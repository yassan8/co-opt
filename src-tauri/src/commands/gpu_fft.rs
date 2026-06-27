//! GPU-accelerated FFT using Apple Accelerate framework (macOS only)
//! 
//! This module provides an Accelerate-based 2D FFT implementation for PSF calculations
//! that automatically uses Apple Silicon GPU/AMX hardware acceleration.
//! Falls back to CPU rustfft on non-macOS platforms.

#[cfg(target_os = "macos")]
use std::os::raw::{c_int, c_uint};

// vDSP FFT external functions from Accelerate framework
#[cfg(target_os = "macos")]
#[link(name = "Accelerate", kind = "framework")]
extern "C" {
    // FFT setup
    fn vDSP_create_fftsetup(log2n: c_uint, radix: c_int) -> *mut std::ffi::c_void;
    fn vDSP_destroy_fftsetup(setup: *mut std::ffi::c_void);
    
    // 1D FFT (we'll use this for 2D by doing row + column transforms)
    fn vDSP_fft_zip(
        setup: *mut std::ffi::c_void,
        c: *const std::ffi::c_void,
        stride: c_int,
        log2n: c_uint,
        direction: c_int,
    );
}

#[cfg(target_os = "macos")]
#[repr(C)]
struct DSPSplitComplex {
    realp: *mut f32,
    imagp: *mut f32,
}

/// Check if GPU/Accelerate is available
#[allow(dead_code)]
pub fn is_gpu_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        true // Accelerate is always available on macOS
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Initialize GPU (no-op for Accelerate, always available on macOS)
#[allow(dead_code)]
pub fn init_gpu() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Accelerate FFT only available on macOS".to_string())
    }
}

/// Perform 2D FFT using Apple Accelerate vDSP
#[cfg(target_os = "macos")]
pub fn fft2d_forward_gpu(real: &mut [Vec<f64>], imag: &mut [Vec<f64>]) -> Result<(), String> {
    let h = real.len();
    if h == 0 {
        return Err("fft2d_forward_gpu: empty input".to_string());
    }
    let w = real[0].len();
    if w == 0 {
        return Err("fft2d_forward_gpu: empty row".to_string());
    }
    
    // Validate dimensions are powers of 2 (required by vDSP)
    if !w.is_power_of_two() || !h.is_power_of_two() {
        return Err(format!("fft2d_forward_gpu: dimensions must be power of 2, got {}x{}", w, h));
    }
    
    let log2w = w.trailing_zeros();
    let log2h = h.trailing_zeros();
    
    // Convert f64 to f32 (vDSP uses single precision)
    let mut real_f32: Vec<Vec<f32>> = real.iter()
        .map(|row| row.iter().map(|&x| x as f32).collect())
        .collect();
    let mut imag_f32: Vec<Vec<f32>> = imag.iter()
        .map(|row| row.iter().map(|&x| x as f32).collect())
        .collect();
    
    unsafe {
        // Create FFT setup for rows
        let setup_row = vDSP_create_fftsetup(log2w, 2);
        if setup_row.is_null() {
            return Err("Failed to create vDSP FFT setup for rows".to_string());
        }
        
        // FFT on each row
        for y in 0..h {
            let split = DSPSplitComplex {
                realp: real_f32[y].as_mut_ptr(),
                imagp: imag_f32[y].as_mut_ptr(),
            };
            
            vDSP_fft_zip(
                setup_row,
                &split as *const _ as *const _,
                1,
                log2w,
                1, // forward direction
            );
        }
        
        vDSP_destroy_fftsetup(setup_row);
        
        // Create FFT setup for columns
        let setup_col = vDSP_create_fftsetup(log2h, 2);
        if setup_col.is_null() {
            return Err("Failed to create vDSP FFT setup for columns".to_string());
        }
        
        // Transpose and FFT on each column
        for x in 0..w {
            let mut col_real: Vec<f32> = (0..h).map(|y| real_f32[y][x]).collect();
            let mut col_imag: Vec<f32> = (0..h).map(|y| imag_f32[y][x]).collect();
            
            let split = DSPSplitComplex {
                realp: col_real.as_mut_ptr(),
                imagp: col_imag.as_mut_ptr(),
            };
            
            vDSP_fft_zip(
                setup_col,
                &split as *const _ as *const _,
                1,
                log2h,
                1, // forward direction
            );
            
            // Copy back
            for y in 0..h {
                real_f32[y][x] = col_real[y];
                imag_f32[y][x] = col_imag[y];
            }
        }
        
        vDSP_destroy_fftsetup(setup_col);
    }
    
    // Convert back to f64
    for y in 0..h {
        for x in 0..w {
            real[y][x] = real_f32[y][x] as f64;
            imag[y][x] = imag_f32[y][x] as f64;
        }
    }
    
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn fft2d_forward_gpu(_real: &mut [Vec<f64>], _imag: &mut [Vec<f64>]) -> Result<(), String> {
    Err("Accelerate FFT only available on macOS".to_string())
}

/// Hybrid FFT: Try GPU first, fall back to CPU if unavailable
pub fn fft2d_forward_hybrid(
    real: &mut [Vec<f64>], 
    imag: &mut [Vec<f64>],
    cpu_fallback: impl FnOnce(&mut [Vec<f64>], &mut [Vec<f64>]) -> Result<(), String>
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        match fft2d_forward_gpu(real, imag) {
            Ok(()) => return Ok(()),
            Err(e) => {
                // Only log non-dimension errors (dimension errors are expected for non-power-of-2)
                if !e.contains("must be power of 2") {
                    eprintln!("Accelerate FFT failed ({}), falling back to CPU", e);
                }
            }
        }
    }
    
    // Fall back to CPU
    cpu_fallback(real, imag)
}

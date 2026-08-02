use std::env;
use std::fs;
use std::time::Instant;

use co_opt_pro_lib::commands::optics::{
    run_native_spot_raytrace, NativeSpotRaytraceRequest, NativeSpotSeries,
};
use serde_json::Value;

fn load_rows(project: &Value, key: &str) -> Vec<Value> {
    project
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn parse_project_text(text: &str) -> Result<Value, String> {
    if let Ok(project) = serde_json::from_str::<Value>(text) {
        return Ok(project);
    }
    let wrapped = text
        .strip_prefix("Result: ")
        .ok_or_else(|| "input is neither project JSON nor a browser Result wrapper".to_string())?;
    let json_text = serde_json::from_str::<String>(wrapped)
        .map_err(|error| format!("failed to decode browser Result wrapper: {error}"))?;
    serde_json::from_str(&json_text)
        .map_err(|error| format!("failed to parse wrapped project JSON: {error}"))
}

fn synthetic_project(field_count: usize) -> Value {
    let object_rows = (0..field_count)
        .map(|index| {
            let height = 4.0 * index as f64 / (field_count - 1).max(1) as f64;
            serde_json::json!({
                "id": index + 1,
                "name": format!("Field-{index}"),
                "position": "Rectangle",
                "xHeight": 0.0,
                "yHeight": height
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "source": [{
            "id": 1, "wavelength": 0.5875618, "weight": 1,
            "primary": "Primary Wavelength"
        }],
        "object": object_rows,
        "opticalSystem": [
            {
                "id": 0, "object type": "Object", "surfType": "Spherical",
                "radius": "INF", "thickness": 10.0, "material": "AIR", "semidia": 10.0
            },
            {
                "id": 1, "object type": "Stop", "surfType": "Spherical",
                "radius": "INF", "thickness": 20.0, "material": "AIR", "semidia": 5.0
            },
            {
                "id": 2, "object type": "Image", "surfType": "Spherical",
                "radius": "INF", "thickness": 0.0, "material": "AIR", "semidia": 10.0
            }
        ]
    })
}

fn rms_spot_um(series: &NativeSpotSeries) -> Option<f64> {
    let mut sum_squared = 0.0;
    let mut count = 0usize;
    for point in &series.points {
        if point.x_um.is_finite() && point.y_um.is_finite() {
            sum_squared += point.x_um * point.x_um + point.y_um * point.y_um;
            count += 1;
        }
    }
    (count > 0).then(|| (sum_squared / count as f64).sqrt())
}

fn request(
    optical_system_rows: Vec<Value>,
    source_rows: Vec<Value>,
    object_rows: Vec<Value>,
    ray_count: u32,
) -> NativeSpotRaytraceRequest {
    let surface_index = optical_system_rows
        .iter()
        .enumerate()
        .rev()
        .find(|(_, row)| {
            row.get("object type")
                .and_then(Value::as_str)
                .map(|value| value.trim().eq_ignore_ascii_case("image"))
                .unwrap_or(false)
        })
        .map(|(index, _)| index)
        .unwrap_or_else(|| optical_system_rows.len().saturating_sub(1));
    NativeSpotRaytraceRequest {
        optical_system_rows,
        source_rows,
        object_rows,
        surface_index: Some(surface_index),
        ray_count: Some(ray_count),
        ring_count: Some(10),
        pattern: Some("annular".to_string()),
        wavelength_mode: Some("primary".to_string()),
        independent_object_origins: true,
        ray_series: Vec::new(),
    }
}

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) * 0.5
    } else {
        values[middle]
    }
}

fn main() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    let input = args
        .first()
        .cloned()
        .unwrap_or_else(|| "Examples/default-load.json".to_string());
    let ray_count = args
        .get(1)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(64)
        .max(1);
    let rounds = args
        .get(2)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5)
        .max(1);
    let field_count = args
        .get(3)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(5)
        .max(2);

    let project = if input.eq_ignore_ascii_case("synthetic") {
        synthetic_project(field_count)
    } else {
        let project_text = fs::read_to_string(&input)
            .map_err(|error| format!("failed to read {input}: {error}"))?;
        parse_project_text(&project_text)?
    };
    let optical_system_rows = load_rows(&project, "opticalSystem");
    let source_rows = load_rows(&project, "source");
    let mut object_rows = load_rows(&project, "object");
    if object_rows.len() < 2 {
        object_rows = (0..field_count)
            .map(|index| {
                let angle = 20.0 * index as f64 / (field_count - 1) as f64;
                serde_json::json!({
                    "id": index + 1,
                    "name": format!("Field-{index}"),
                    "position": "Angle",
                    "xHeightAngle": 0.0,
                    "yHeightAngle": angle
                })
            })
            .collect();
    }
    if optical_system_rows.is_empty() || object_rows.len() < 2 {
        return Err("project needs opticalSystem rows and at least two object fields".to_string());
    }

    let run_individual = || -> Result<Vec<f64>, String> {
        object_rows
            .iter()
            .map(|object_row| {
                let response = run_native_spot_raytrace(request(
                    optical_system_rows.clone(),
                    source_rows.clone(),
                    vec![object_row.clone()],
                    ray_count,
                ))?;
                response
                    .series
                    .first()
                    .and_then(rms_spot_um)
                    .ok_or_else(|| "individual Spot result is empty".to_string())
            })
            .collect()
    };
    let run_batch = || -> Result<Vec<f64>, String> {
        let response = run_native_spot_raytrace(request(
            optical_system_rows.clone(),
            source_rows.clone(),
            object_rows.clone(),
            ray_count,
        ))?;
        response
            .series
            .iter()
            .map(|series| {
                rms_spot_um(series).ok_or_else(|| "batch Spot result is empty".to_string())
            })
            .collect()
    };

    let expected = run_individual()?;
    let actual = run_batch()?;
    if expected.len() != actual.len() {
        return Err(format!(
            "series count mismatch: individual={} batch={}",
            expected.len(),
            actual.len()
        ));
    }
    let max_abs_diff_um = expected
        .iter()
        .zip(actual.iter())
        .map(|(left, right)| (left - right).abs())
        .fold(0.0_f64, f64::max);
    if max_abs_diff_um > 1e-9 {
        return Err(format!(
            "Spot parity mismatch: max_abs_diff_um={max_abs_diff_um:.12}"
        ));
    }

    let mut individual_times = Vec::with_capacity(rounds);
    let mut batch_times = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        let started = Instant::now();
        run_individual()?;
        individual_times.push(started.elapsed().as_secs_f64() * 1000.0);

        let started = Instant::now();
        run_batch()?;
        batch_times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let individual_median_ms = median(&mut individual_times);
    let batch_median_ms = median(&mut batch_times);
    println!(
        "spot-batch-profile fields={} rays={} rounds={} individual_median_ms={:.3} batch_median_ms={:.3} speedup={:.3} max_abs_diff_um={:.12}",
        object_rows.len(),
        ray_count,
        rounds,
        individual_median_ms,
        batch_median_ms,
        individual_median_ms / batch_median_ms.max(f64::EPSILON),
        max_abs_diff_um,
    );
    Ok(())
}

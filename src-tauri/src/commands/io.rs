use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileRequest {
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextFileResponse {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextFileRequest {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteTextFileResponse {
    pub path: String,
    pub bytes_written: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFreeCadDocumentRequest {
    pub output_path: String,
    pub stl_text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFreeCadDocumentResponse {
    pub path: String,
    pub solid_count: usize,
    pub free_cad_command: String,
}

fn freecad_command_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(value) = std::env::var("FREECAD_CMD") {
        if !value.trim().is_empty() {
            candidates.push(PathBuf::from(value));
        }
    }

    #[cfg(target_os = "windows")]
    {
        for root in [r"C:\Program Files", r"C:\Program Files (x86)"] {
            if let Ok(entries) = fs::read_dir(root) {
                let mut installs = entries
                    .flatten()
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        name.to_ascii_lowercase()
                            .starts_with("freecad")
                            .then_some(entry.path())
                    })
                    .collect::<Vec<_>>();
                installs.sort_by(|a, b| b.cmp(a));
                for install in installs {
                    candidates.push(install.join("bin").join("FreeCADCmd.exe"));
                }
            }
        }
        candidates.push(PathBuf::from("FreeCADCmd.exe"));
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from(
            "/Applications/FreeCAD.app/Contents/Resources/bin/FreeCADCmd",
        ));
        candidates.push(PathBuf::from("FreeCADCmd"));
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        candidates.push(PathBuf::from("freecadcmd"));
        candidates.push(PathBuf::from("FreeCADCmd"));
    }

    candidates
}

const FREECAD_EXPORT_SCRIPT: &str = r#"
import os
import FreeCAD as App
import Mesh
import Part

input_path = os.environ['COOPT_STL_INPUT']
output_path = os.environ['COOPT_FCSTD_OUTPUT']

doc = App.newDocument('co_opt_optical_system')
mesh = Mesh.Mesh(input_path)
shape = Part.Shape()
shape.makeShapeFromMesh(mesh.Topology, 0.01)
shape = shape.removeSplitter()

shells = [shape] if shape.ShapeType == 'Shell' else list(shape.Shells)
solid_count = 0
for shell in shells:
    if not shell.isClosed():
        continue
    solid = Part.makeSolid(shell).removeSplitter()
    solid_count += 1
    obj = doc.addObject('Part::Feature', 'LensSolid_%03d' % solid_count)
    obj.Label = 'Lens Solid %03d' % solid_count
    obj.Shape = solid

if solid_count == 0:
    raise RuntimeError('No closed solids were found in the generated STL mesh')

doc.addObject('App::FeaturePython', 'ExportInfo').addProperty('App::PropertyInteger', 'SolidCount')
doc.ExportInfo.SolidCount = solid_count
doc.recompute()
doc.saveAs(output_path)
print('COOPT_SOLID_COUNT=%d' % solid_count)
"#;

#[tauri::command]
pub fn read_text_file(req: ReadTextFileRequest) -> Result<ReadTextFileResponse, String> {
    let content = fs::read_to_string(&req.path)
        .map_err(|e| format!("failed to read file '{}': {e}", req.path))?;

    Ok(ReadTextFileResponse {
        path: req.path,
        content,
    })
}

#[tauri::command]
pub fn write_text_file(req: WriteTextFileRequest) -> Result<WriteTextFileResponse, String> {
    fs::write(&req.path, req.content.as_bytes())
        .map_err(|e| format!("failed to write file '{}': {e}", req.path))?;

    Ok(WriteTextFileResponse {
        path: req.path,
        bytes_written: req.content.len(),
    })
}

#[tauri::command]
pub fn export_free_cad_document(
    req: ExportFreeCadDocumentRequest,
) -> Result<ExportFreeCadDocumentResponse, String> {
    let output = PathBuf::from(req.output_path.trim());
    if output.as_os_str().is_empty() {
        return Err("FreeCAD output path is empty".to_string());
    }
    let output = if output
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("fcstd"))
        == Some(true)
    {
        output
    } else {
        output.with_extension("FCStd")
    };
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!(
                "output directory does not exist: '{}'",
                parent.display()
            ));
        }
    }

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("failed to create temporary export name: {e}"))?
        .as_nanos();
    let temp_root = std::env::temp_dir();
    let stl_path = temp_root.join(format!("co-opt-{stamp}.stl"));
    let script_path = temp_root.join(format!("co-opt-freecad-{stamp}.py"));
    fs::write(&stl_path, req.stl_text.as_bytes()).map_err(|e| {
        format!(
            "failed to create temporary STL '{}': {e}",
            stl_path.display()
        )
    })?;
    fs::write(&script_path, FREECAD_EXPORT_SCRIPT.as_bytes()).map_err(|e| {
        format!(
            "failed to create temporary FreeCAD script '{}': {e}",
            script_path.display()
        )
    })?;

    let mut last_error = String::new();
    let mut success: Option<(String, String)> = None;
    for candidate in freecad_command_candidates() {
        if candidate.is_absolute() && !Path::new(&candidate).is_file() {
            continue;
        }
        match Command::new(&candidate)
            .arg(&script_path)
            .env("COOPT_STL_INPUT", &stl_path)
            .env("COOPT_FCSTD_OUTPUT", &output)
            .output()
        {
            Ok(result) if result.status.success() && output.is_file() => {
                success = Some((
                    candidate.display().to_string(),
                    String::from_utf8_lossy(&result.stdout).to_string(),
                ));
                break;
            }
            Ok(result) => {
                last_error = format!(
                    "{} exited with {}: {}",
                    candidate.display(),
                    result.status,
                    String::from_utf8_lossy(&result.stderr).trim()
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => last_error = format!("failed to run {}: {error}", candidate.display()),
        }
    }

    let _ = fs::remove_file(&stl_path);
    let _ = fs::remove_file(&script_path);

    let (command, stdout) = success.ok_or_else(|| {
        let detail = if last_error.is_empty() { "FreeCADCmd was not found".to_string() } else { last_error };
        format!("{detail}. Install FreeCAD or set the FREECAD_CMD environment variable to FreeCADCmd.exe")
    })?;
    let solid_count = stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("COOPT_SOLID_COUNT="))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);

    Ok(ExportFreeCadDocumentResponse {
        path: output.display().to_string(),
        solid_count,
        free_cad_command: command,
    })
}

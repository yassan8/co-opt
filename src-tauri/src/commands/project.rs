use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectTemplateResponse {
    pub project: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultProjectResponse {
    pub project: Value,
}

#[tauri::command]
pub fn new_project_template() -> Result<NewProjectTemplateResponse, String> {
    let project = json!({
        "configurations": [
            {
                "id": 1,
                "name": "Config 1",
                "schemaVersion": "1.0",
                "blocks": [
                    {
                        "blockId": "ObjectSurface-1",
                        "blockType": "ObjectSurface",
                        "role": null,
                        "constraints": {},
                        "parameters": { "objectDistanceMode": "INF" },
                        "variables": {},
                        "metadata": { "source": "default" }
                    },
                    {
                        "blockId": "Stop-1",
                        "blockType": "Stop",
                        "role": null,
                        "constraints": {},
                        "parameters": { "semiDiameter": 10 },
                        "variables": {},
                        "metadata": { "source": "default" }
                    },
                    {
                        "blockId": "ImageSurface-1",
                        "blockType": "ImageSurface",
                        "role": null,
                        "constraints": {},
                        "parameters": { "semidiaMode": "Manual" },
                        "variables": {},
                        "metadata": { "source": "default" }
                    }
                ],
                "source": [
                    { "id": 1, "wavelength": 0.4358343, "weight": 1, "primary": "", "angle": 0 },
                    { "id": 2, "wavelength": 0.5875618, "weight": 1, "primary": "Primary Wavelength", "angle": 0 },
                    { "id": 3, "wavelength": 0.6562725, "weight": 1, "primary": "", "angle": 0 }
                ],
                "object": [
                    { "id": 1, "xHeightAngle": 0, "yHeightAngle": 0, "position": "Angle", "angle": 0 },
                    { "id": 2, "xHeightAngle": 0, "yHeightAngle": 17.05, "position": "Angle", "angle": 0 }
                ],
                "opticalSystem": [],
                "systemData": { "referenceFocalLength": "" },
                "metadata": {
                    "created": "1970-01-01T00:00:00.000Z",
                    "modified": "1970-01-01T00:00:00.000Z",
                    "locked": false
                },
                "meritFunction": []
            }
        ],
        "activeConfigId": 1,
        "meritFunction": [],
        "systemRequirements": [],
        "optimizationRules": {}
    });

    Ok(NewProjectTemplateResponse { project })
}

#[tauri::command]
pub fn load_default_project() -> Result<DefaultProjectResponse, String> {
    let raw = include_str!("../../../Examples/default-load.json");
    let project: Value = serde_json::from_str(raw)
        .map_err(|e| format!("failed to parse embedded default project json: {e}"))?;
    Ok(DefaultProjectResponse { project })
}

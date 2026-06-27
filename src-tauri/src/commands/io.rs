use serde::{Deserialize, Serialize};
use std::fs;

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

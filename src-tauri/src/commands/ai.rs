use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
    pub provider: String,
    pub model: String,
    pub user_message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatResponse {
    pub provider: String,
    pub model: String,
    pub answer: String,
}

#[tauri::command]
pub fn ai_chat_stub(req: AiChatRequest) -> Result<AiChatResponse, String> {
    let answer = format!(
        "[stub] provider='{}' model='{}' promptChars={}",
        req.provider,
        req.model,
        req.user_message.chars().count()
    );

    Ok(AiChatResponse {
        provider: req.provider,
        model: req.model,
        answer,
    })
}

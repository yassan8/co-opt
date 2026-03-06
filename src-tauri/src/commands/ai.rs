use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;

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
pub async fn ai_chat_stub(req: AiChatRequest) -> Result<AiChatResponse, String> {
    let provider = req.provider.trim().to_lowercase();
    let requested_model = req.model.trim().to_string();

    let (model, answer) = match provider.as_str() {
        "openai" => {
            let key = get_env_key("COOPT_OPENAI_API_KEY")?;
            let resolved_model = if requested_model.is_empty() {
                "gpt-4o-mini".to_string()
            } else {
                requested_model.clone()
            };
            let answer = call_openai_chat(&req.user_message, &resolved_model, &key).await?;
            (resolved_model, answer)
        }
        "gemini" => {
            let key = get_env_key("COOPT_GEMINI_API_KEY")?;
            let resolved_model = if requested_model.is_empty() {
                "gemini-2.0-flash".to_string()
            } else {
                requested_model.clone()
            };
            let answer = call_gemini_chat(&req.user_message, &resolved_model, &key).await?;
            (resolved_model, answer)
        }
        other => {
            return Err(format!(
                "unsupported provider '{other}'. supported providers: openai, gemini"
            ))
        }
    };

    Ok(AiChatResponse {
        provider,
        model,
        answer,
    })
}

fn get_env_key(name: &str) -> Result<String, String> {
    let value = env::var(name).unwrap_or_default();
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        return Err(format!(
            "missing API key: set environment variable {name} before launching co-opt-pro"
        ));
    }
    Ok(trimmed)
}

async fn call_openai_chat(prompt: &str, model: &str, api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let payload = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": "You are an expert optical design assistant."},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2
    });

    let response = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("openai request failed: {e}"))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("openai response parse failed: {e}"))?;

    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("openai API error ({status}): {message}"));
    }

    let answer = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|first| first.get("message"))
        .and_then(|msg| msg.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "openai API returned empty assistant content".to_string())?;

    Ok(answer.to_string())
}

async fn call_gemini_chat(prompt: &str, model: &str, api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    );

    let payload = json!({
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}]
            }
        ]
    });

    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("gemini response parse failed: {e}"))?;

    if !status.is_success() {
        let message = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("gemini API error ({status}): {message}"));
    }

    let parts = body
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|first| first.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .ok_or_else(|| "gemini API returned no content parts".to_string())?;

    let answer = parts
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");

    if answer.is_empty() {
        return Err("gemini API returned empty assistant content".to_string());
    }

    Ok(answer)
}

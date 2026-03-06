mod commands;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::optics::optics_echo,
            commands::optics::run_raytrace_preview,
            commands::optimizer::run_optimizer_step,
            commands::analysis::recommend_wavefront_grid,
            commands::analysis::recommend_wavefront_grid_for_time,
            commands::analysis::run_analysis_preview,
            commands::io::read_text_file,
            commands::io::write_text_file,
            commands::ai::ai_chat_stub,
            commands::project::new_project_template,
            commands::project::load_default_project,
            commands::zemax::generate_zmx_text,
            commands::zemax::parse_zmx_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running co-opt-pro tauri application");
}

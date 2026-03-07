mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::optics::optics_echo,
            commands::optics::run_raytrace_preview,
            commands::optics::run_native_spot_raytrace,
            commands::optics::run_native_spherical_aberration,
            commands::optics::run_native_astigmatism,
            commands::optics::log_native_astigmatism_debug,
            commands::optimizer::run_optimizer_step,
            commands::analysis::recommend_wavefront_grid,
            commands::analysis::recommend_wavefront_grid_for_time,
            commands::analysis::run_analysis_preview,
            commands::analysis::run_analysis_compute,
            commands::analysis::run_system_data_report,
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

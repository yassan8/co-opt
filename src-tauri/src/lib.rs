pub mod commands;

fn configure_native_rayon_pool() {
    // Optimizer MTF batches are CPU-bound and do not share the WebView's WASM
    // worker gate.  Establish the native pool before any analysis command can
    // lazily create Rayon’s default pool, using the OS-visible CPU count.
    let threads = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .max(1);
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .thread_name(|index| format!("coopt-rayon-{}", index))
        .build_global();
}

pub fn run() {
    configure_native_rayon_pool();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let _ = commands::settings::ensure_desktop_settings_file(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::optics::optics_echo,
            commands::optics::run_raytrace_preview,
            commands::optics::run_native_spot_raytrace,
            commands::optics::run_native_chief_ray_angle,
            commands::optics::run_native_spherical_aberration,
            commands::optics::run_native_astigmatism,
            commands::optics::run_native_transverse_aberration,
            commands::optics::run_native_transverse_rms_um,
            commands::optics::run_native_transverse_rms_batch,
            commands::optics::run_native_opd_map,
            commands::optics::run_native_opd_rms_waves,
            commands::optics::run_native_psf_map,
            commands::optics::run_native_mtf_map,
            commands::optics::run_native_optimizer_mtf_batch,
            commands::optics::run_native_through_focus_mtf_map,
            commands::optics::run_native_field_mtf_map,
            commands::optics::log_native_astigmatism_debug,
            commands::optics::run_native_distortion,
            commands::optics::run_native_grid_distortion,
            commands::optics::run_native_magnification_chromatic_aberration,
            commands::optimizer::run_optimizer_step,
            commands::optimizer::evaluate_optimizer_candidates,
            commands::optimizer::evaluate_optimizer_candidates_multi_scenario,
            commands::optimizer::optimizer_request_stop,
            commands::optimizer::optimizer_clear_stop,
            commands::optimizer::optimizer_drop_session,
            commands::power::start_prevent_display_sleep,
            commands::power::stop_prevent_display_sleep,
            commands::analysis::recommend_wavefront_grid,
            commands::analysis::recommend_wavefront_grid_for_time,
            commands::analysis::run_analysis_preview,
            commands::analysis::run_analysis_compute,
            commands::analysis::run_native_paraxial_metrics,
            commands::analysis::run_native_seidel,
            commands::analysis::run_system_data_report,
            commands::io::read_text_file,
            commands::io::write_text_file,
            commands::io::export_free_cad_document,
            commands::ai::ai_chat_stub,
            commands::project::new_project_template,
            commands::project::load_default_project,
            commands::settings::read_desktop_setting,
            commands::settings::write_desktop_setting,
            commands::settings::get_desktop_settings_path,
            commands::window::open_render_window,
            commands::window::sync_render_rows,
            commands::zemax::generate_zmx_text,
            commands::zemax::parse_zmx_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running co-opt-pro tauri application");
}

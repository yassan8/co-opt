use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::f64::consts::PI;

const C_M_PER_S: f64 = 299_792_458.0;

fn default_one() -> f64 {
    1.0
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
    fn add(self, other: Self) -> Self {
        Self::new(self.x + other.x, self.y + other.y, self.z + other.z)
    }
    fn sub(self, other: Self) -> Self {
        Self::new(self.x - other.x, self.y - other.y, self.z - other.z)
    }
    fn scale(self, scale: f64) -> Self {
        Self::new(self.x * scale, self.y * scale, self.z * scale)
    }
    fn dot(self, other: Self) -> f64 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }
    fn cross(self, other: Self) -> Self {
        Self::new(
            self.y * other.z - self.z * other.y,
            self.z * other.x - self.x * other.z,
            self.x * other.y - self.y * other.x,
        )
    }
    fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }
    fn normalized(self) -> Self {
        let n = self.norm();
        if n > 1e-15 {
            self.scale(1.0 / n)
        } else {
            Self::new(0.0, 0.0, 1.0)
        }
    }
    fn axis(self, axis: usize) -> f64 {
        if axis == 0 {
            self.x
        } else if axis == 1 {
            self.y
        } else {
            self.z
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EulerDeg {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformSpec {
    #[serde(default)]
    pub position_mm: Vec3,
    #[serde(default)]
    pub rotation_deg: EulerDeg,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApertureSpec {
    #[serde(default = "default_aperture_kind")]
    pub kind: String,
    #[serde(default)]
    pub width_mm: f64,
    #[serde(default)]
    pub height_mm: f64,
    #[serde(default)]
    pub radius_mm: f64,
}

fn default_aperture_kind() -> String {
    "rectangle".to_string()
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetProfileSpec {
    #[serde(default = "default_flat")]
    pub kind: String,
    #[serde(default = "default_target_span")]
    pub span_mm: f64,
    #[serde(default)]
    pub offset_um: f64,
    #[serde(default)]
    pub amplitude_um: f64,
    #[serde(default = "default_period")]
    pub period_mm: f64,
    #[serde(default)]
    pub step_position_mm: f64,
    #[serde(default)]
    pub csv_points: Vec<[f64; 2]>,
}

fn default_flat() -> String {
    "flat".to_string()
}
fn default_period() -> f64 {
    1.0
}
fn default_target_span() -> f64 {
    // Preserves the legacy amplitude-as-slope result when an older request
    // does not yet provide the physical Target width.
    2.0
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometrySpec {
    #[serde(default = "default_plane")]
    pub kind: String,
    #[serde(default)]
    pub radius_mm: f64,
    #[serde(default)]
    pub vertex_a: Vec3,
    #[serde(default)]
    pub vertex_b: Vec3,
    #[serde(default)]
    pub vertex_c: Vec3,
    #[serde(default)]
    pub target_profile: Option<TargetProfileSpec>,
}

fn default_plane() -> String {
    "plane".to_string()
}
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComplexEfficiencySpec {
    #[serde(default)]
    pub wavelength_nm: f64,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub amplitude: f64,
    #[serde(default)]
    pub phase_deg: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BsdfSampleSpec {
    #[serde(default)]
    pub angle_deg: f64,
    #[serde(default)]
    pub value: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionSpec {
    #[serde(default = "default_transmit")]
    pub kind: String,
    #[serde(default = "default_one")]
    pub transmission: f64,
    #[serde(default = "default_one")]
    pub reflectivity: f64,
    #[serde(default)]
    pub phase_deg: f64,
    #[serde(default = "default_half")]
    pub reflectance: f64,
    #[serde(default = "default_half")]
    pub transmittance: f64,
    #[serde(default = "default_ninety")]
    pub reflected_phase_deg: f64,
    #[serde(default)]
    pub complex_efficiency: Vec<ComplexEfficiencySpec>,
    #[serde(default)]
    pub groove_direction: Vec3,
    #[serde(default = "default_one")]
    pub substrate_reflectivity: f64,
    #[serde(default)]
    pub nondiffracted_reflectivity: f64,
    #[serde(default)]
    pub blaze_angle_deg: f64,
    #[serde(default)]
    pub blaze_wavelength_nm: f64,
    #[serde(default)]
    pub incident_side: String,
    #[serde(default)]
    pub transmitted_phase_deg: f64,
    #[serde(default)]
    pub beam_splitter_model: String,
    #[serde(default = "default_glass")]
    pub substrate_index_nd: f64,
    #[serde(default = "default_abbe")]
    pub substrate_abbe_number: f64,
    #[serde(default)]
    pub substrate_thickness_mm: f64,
    #[serde(default)]
    pub wedge_deg: f64,
    #[serde(default)]
    pub back_surface_reflectance: f64,
    #[serde(default)]
    pub focal_length_x_mm: f64,
    #[serde(default)]
    pub focal_length_y_mm: f64,
    #[serde(default)]
    pub groove_density_lines_per_mm: f64,
    #[serde(default)]
    pub allowed_orders: Vec<i32>,
    #[serde(default = "default_grating_efficiency")]
    pub efficiency: f64,
    #[serde(default = "default_one")]
    pub n_front: f64,
    #[serde(default = "default_glass")]
    pub n_back: f64,
    #[serde(default)]
    pub detector_id: String,
    #[serde(default)]
    pub scatter_model: String,
    #[serde(default = "default_scatter_samples")]
    pub scatter_samples: usize,
    #[serde(default = "default_one")]
    pub scatter_a: f64,
    #[serde(default = "default_scatter_b")]
    pub scatter_b: f64,
    #[serde(default = "default_scatter_g")]
    pub scatter_g: f64,
    #[serde(default = "default_scatter_sigma")]
    pub scatter_sigma_deg: f64,
    #[serde(default)]
    pub bsdf_samples: Vec<BsdfSampleSpec>,
}

fn default_transmit() -> String {
    "transmit".to_string()
}
fn default_half() -> f64 {
    0.5
}
fn default_ninety() -> f64 {
    90.0
}
fn default_grating_efficiency() -> f64 {
    0.75
}
fn default_glass() -> f64 {
    1.5
}
fn default_abbe() -> f64 {
    60.0
}
fn default_scatter_samples() -> usize {
    16
}
fn default_scatter_b() -> f64 {
    0.01
}
fn default_scatter_g() -> f64 {
    2.0
}
fn default_scatter_sigma() -> f64 {
    5.0
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSpec {
    pub id: String,
    #[serde(default)]
    pub component_id: String,
    #[serde(default)]
    pub transform: TransformSpec,
    #[serde(default)]
    pub geometry: GeometrySpec,
    #[serde(default)]
    pub aperture: ApertureSpec,
    #[serde(default)]
    pub interaction: InteractionSpec,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumSpec {
    #[serde(default)]
    pub relative_delay_fs: f64,
    #[serde(default = "default_broadband")]
    pub kind: String,
    #[serde(default = "default_center_nm")]
    pub center_wavelength_nm: f64,
    #[serde(default)]
    pub min_wavelength_nm: f64,
    #[serde(default)]
    pub max_wavelength_nm: f64,
    #[serde(default = "default_bandwidth_nm")]
    pub bandwidth_fwhm_nm: f64,
    #[serde(default = "default_spectral_samples")]
    pub spectral_samples: usize,
    #[serde(default = "default_shape")]
    pub shape: String,
    #[serde(default)]
    pub repetition_rate_hz: f64,
    #[serde(default)]
    pub ceo_frequency_hz: f64,
    #[serde(default = "default_line_count")]
    pub line_count: usize,
    #[serde(default)]
    pub line_width_hz: f64,
    #[serde(default)]
    pub initial_phase_rad: f64,
    #[serde(default)]
    pub group_delay_dispersion_fs2: f64,
}

fn default_broadband() -> String {
    "supercontinuum".to_string()
}
fn default_center_nm() -> f64 {
    600.0
}
fn default_bandwidth_nm() -> f64 {
    160.0
}
fn default_spectral_samples() -> usize {
    33
}
fn default_shape() -> String {
    "gaussian".to_string()
}
fn default_line_count() -> usize {
    65
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpec {
    pub id: String,
    #[serde(default)]
    pub coherence_group_id: String,
    #[serde(default)]
    pub transform: TransformSpec,
    #[serde(default = "default_one")]
    pub total_power_w: f64,
    #[serde(default = "default_beam_diameter")]
    pub beam_diameter_mm: f64,
    #[serde(default)]
    pub divergence_deg: f64,
    #[serde(default = "default_gaussian")]
    pub spatial_profile: String,
    #[serde(default = "default_spatial_samples")]
    pub spatial_samples: usize,
    #[serde(default)]
    pub spectrum: SpectrumSpec,
}

fn default_beam_diameter() -> f64 {
    1.0
}
fn default_gaussian() -> String {
    "gaussian".to_string()
}
fn default_spatial_samples() -> usize {
    49
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorSpec {
    pub id: String,
    #[serde(default = "default_area")]
    pub kind: String,
    #[serde(default)]
    pub transform: TransformSpec,
    #[serde(default = "default_pixels")]
    pub pixel_count_x: usize,
    #[serde(default = "default_pixels")]
    pub pixel_count_y: usize,
    #[serde(default = "default_pitch")]
    pub pixel_pitch_um: f64,
    #[serde(default = "default_one")]
    pub fill_factor: f64,
    #[serde(default = "default_one")]
    pub responsivity: f64,
    #[serde(default)]
    pub front_only: bool,
    #[serde(default = "default_sample_rate")]
    pub sampling_rate_hz: f64,
    #[serde(default = "default_time_samples")]
    pub sample_count: usize,
    #[serde(default)]
    pub integration_time_s: f64,
}

impl Default for DetectorSpec {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: default_area(),
            transform: TransformSpec::default(),
            pixel_count_x: default_pixels(),
            pixel_count_y: default_pixels(),
            pixel_pitch_um: default_pitch(),
            fill_factor: default_one(),
            responsivity: default_one(),
            front_only: false,
            sampling_rate_hz: default_sample_rate(),
            sample_count: default_time_samples(),
            integration_time_s: 0.0,
        }
    }
}
fn default_area() -> String {
    "area".to_string()
}
fn default_pixels() -> usize {
    128
}
fn default_pitch() -> f64 {
    10.0
}
fn default_sample_rate() -> f64 {
    100_000_000.0
}
fn default_time_samples() -> usize {
    1024
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSettings {
    #[serde(default = "default_interactions")]
    pub max_interactions: usize,
    #[serde(default = "default_min_power")]
    pub min_relative_power: f64,
    #[serde(default = "default_max_rays")]
    pub max_generated_rays: usize,
    #[serde(default = "default_epsilon")]
    pub ray_epsilon_mm: f64,
    #[serde(default = "default_segment_limit")]
    pub render_segment_limit: usize,
}

impl Default for TraceSettings {
    fn default() -> Self {
        Self {
            max_interactions: default_interactions(),
            min_relative_power: default_min_power(),
            max_generated_rays: default_max_rays(),
            ray_epsilon_mm: default_epsilon(),
            render_segment_limit: default_segment_limit(),
        }
    }
}

fn default_interactions() -> usize {
    32
}
fn default_min_power() -> f64 {
    1e-10
}
fn default_max_rays() -> usize {
    1_000_000
}
fn default_epsilon() -> f64 {
    1e-7
}
fn default_segment_limit() -> usize {
    20_000
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRequest {
    #[serde(default)]
    pub surfaces: Vec<SurfaceSpec>,
    #[serde(default)]
    pub sources: Vec<SourceSpec>,
    #[serde(default)]
    pub detectors: Vec<DetectorSpec>,
    #[serde(default)]
    pub settings: TraceSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpectrumLineResult {
    pub source_id: String,
    pub line_index: i64,
    pub frequency_hz: f64,
    pub wavelength_nm: f64,
    pub power_w: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RaySegmentResult {
    pub ray_id: u64,
    pub parent_ray_id: Option<u64>,
    pub start_mm: Vec3,
    pub end_mm: Vec3,
    pub wavelength_nm: f64,
    pub power_w: f64,
    pub surface_id: String,
    pub history: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RfBeatResult {
    pub line_index: i64,
    pub frequency_hz: f64,
    pub power_w: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorSpectralFieldResult {
    pub pixel_x: usize,
    pub pixel_y: usize,
    pub coherence_group_id: String,
    pub frequency_hz: f64,
    pub wavelength_nm: f64,
    pub field_re: f64,
    pub field_im: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectorResult {
    pub detector_id: String,
    pub kind: String,
    pub width: usize,
    pub height: usize,
    pub intensity_w_per_pixel: Vec<f64>,
    pub integrated_power_w: f64,
    pub maximum_w_per_pixel: f64,
    pub hit_count: usize,
    pub spectral_fields: Vec<DetectorSpectralFieldResult>,
    pub time_seconds: Vec<f64>,
    pub time_signal_w: Vec<f64>,
    pub rf_beats: Vec<RfBeatResult>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnergySummary {
    pub emitted_power_w: f64,
    pub detected_ray_power_w: f64,
    pub escaped_power_w: f64,
    pub absorbed_power_w: f64,
    pub truncated_power_w: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhostPathResult {
    pub signature: String,
    pub detected_power_w: f64,
    pub hit_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    pub segments: Vec<RaySegmentResult>,
    pub detectors: Vec<DetectorResult>,
    pub spectrum_lines: Vec<SpectrumLineResult>,
    pub ghost_paths: Vec<GhostPathResult>,
    pub energy: EnergySummary,
    pub generated_ray_count: usize,
    pub terminated_ray_count: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy)]
struct Complex {
    re: f64,
    im: f64,
}

impl Complex {
    fn from_power(power: f64) -> Self {
        Self {
            re: power.max(0.0).sqrt(),
            im: 0.0,
        }
    }
    fn scale_phase(self, power_scale: f64, phase_rad: f64) -> Self {
        let scale = power_scale.max(0.0).sqrt();
        let c = phase_rad.cos();
        let s = phase_rad.sin();
        Self {
            re: scale * (self.re * c - self.im * s),
            im: scale * (self.re * s + self.im * c),
        }
    }
    fn rotate(self, phase_rad: f64) -> Self {
        self.scale_phase(1.0, phase_rad)
    }
    fn add(self, other: Self) -> Self {
        Self {
            re: self.re + other.re,
            im: self.im + other.im,
        }
    }
    fn norm2(self) -> f64 {
        self.re * self.re + self.im * self.im
    }
    fn mul_conj(self, other: Self) -> Self {
        Self {
            re: self.re * other.re + self.im * other.im,
            im: self.im * other.re - self.re * other.im,
        }
    }
}

#[derive(Clone, Copy)]
struct Mat3 {
    m: [[f64; 3]; 3],
}

impl Mat3 {
    fn from_euler(deg: EulerDeg) -> Self {
        let (sx, cx) = (deg.x * PI / 180.0).sin_cos();
        let (sy, cy) = (deg.y * PI / 180.0).sin_cos();
        let (sz, cz) = (deg.z * PI / 180.0).sin_cos();
        Self {
            m: [
                [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
                [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
                [-sy, cy * sx, cy * cx],
            ],
        }
    }
    fn mul(self, v: Vec3) -> Vec3 {
        Vec3::new(
            self.m[0][0] * v.x + self.m[0][1] * v.y + self.m[0][2] * v.z,
            self.m[1][0] * v.x + self.m[1][1] * v.y + self.m[1][2] * v.z,
            self.m[2][0] * v.x + self.m[2][1] * v.y + self.m[2][2] * v.z,
        )
    }
    fn transpose_mul(self, v: Vec3) -> Vec3 {
        Vec3::new(
            self.m[0][0] * v.x + self.m[1][0] * v.y + self.m[2][0] * v.z,
            self.m[0][1] * v.x + self.m[1][1] * v.y + self.m[2][1] * v.z,
            self.m[0][2] * v.x + self.m[1][2] * v.y + self.m[2][2] * v.z,
        )
    }
}

#[derive(Clone, Copy)]
struct Bounds {
    min: Vec3,
    max: Vec3,
}

impl Bounds {
    fn empty() -> Self {
        Self {
            min: Vec3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY),
            max: Vec3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY),
        }
    }
    fn include(mut self, point: Vec3) -> Self {
        self.min.x = self.min.x.min(point.x);
        self.min.y = self.min.y.min(point.y);
        self.min.z = self.min.z.min(point.z);
        self.max.x = self.max.x.max(point.x);
        self.max.y = self.max.y.max(point.y);
        self.max.z = self.max.z.max(point.z);
        self
    }
    fn union(mut self, other: Self) -> Self {
        self = self.include(other.min);
        self.include(other.max)
    }
    fn centroid(self) -> Vec3 {
        self.min.add(self.max).scale(0.5)
    }
    fn extent(self) -> Vec3 {
        self.max.sub(self.min)
    }
}

struct PreparedSurface {
    spec: SurfaceSpec,
    rotation: Mat3,
    bounds: Bounds,
}

impl PreparedSurface {
    fn local_point(&self, world: Vec3) -> Vec3 {
        self.rotation
            .transpose_mul(world.sub(self.spec.transform.position_mm))
    }
    fn local_vector(&self, world: Vec3) -> Vec3 {
        self.rotation.transpose_mul(world)
    }
    fn world_point(&self, local: Vec3) -> Vec3 {
        self.spec
            .transform
            .position_mm
            .add(self.rotation.mul(local))
    }
    fn world_vector(&self, local: Vec3) -> Vec3 {
        self.rotation.mul(local)
    }
}

enum BvhNode {
    Leaf {
        bounds: Bounds,
        indices: Vec<usize>,
    },
    Branch {
        bounds: Bounds,
        left: Box<BvhNode>,
        right: Box<BvhNode>,
    },
}

impl BvhNode {
    fn bounds(&self) -> Bounds {
        match self {
            Self::Leaf { bounds, .. } | Self::Branch { bounds, .. } => *bounds,
        }
    }
}

#[derive(Clone)]
struct SpectrumLine {
    source_id: String,
    coherence_group_id: String,
    line_index: i64,
    frequency_hz: f64,
    wavelength_nm: f64,
    weight: f64,
    initial_phase_rad: f64,
}

#[derive(Clone)]
struct RayState {
    id: u64,
    parent_id: Option<u64>,
    source_id: String,
    coherence_group_id: String,
    line_index: i64,
    frequency_hz: f64,
    wavelength_nm: f64,
    position: Vec3,
    direction: Vec3,
    amplitude: Complex,
    medium_n: f64,
    opl_mm: f64,
    interactions: usize,
    history: Vec<String>,
}

#[derive(Clone)]
struct Hit {
    surface_index: usize,
    t: f64,
    point_world: Vec3,
    point_local: Vec3,
    normal_world: Vec3,
    local_dir_z: f64,
}

#[derive(Clone)]
struct DetectorContribution {
    detector_id: String,
    pixel_x: usize,
    pixel_y: usize,
    source_id: String,
    coherence_group_id: String,
    line_index: i64,
    frequency_hz: f64,
    wavelength_nm: f64,
    field: Complex,
    ray_power_w: f64,
    history: String,
}

fn clamp01(value: f64) -> f64 {
    value.max(0.0).min(1.0)
}

fn prepare_surface(spec: SurfaceSpec) -> PreparedSurface {
    let rotation = Mat3::from_euler(spec.transform.rotation_deg);
    let mut bounds = Bounds::empty();
    if spec.geometry.kind == "triangle" {
        bounds = bounds.include(
            spec.transform
                .position_mm
                .add(rotation.mul(spec.geometry.vertex_a)),
        );
        bounds = bounds.include(
            spec.transform
                .position_mm
                .add(rotation.mul(spec.geometry.vertex_b)),
        );
        bounds = bounds.include(
            spec.transform
                .position_mm
                .add(rotation.mul(spec.geometry.vertex_c)),
        );
    } else if spec.geometry.kind == "sphere" {
        let r = spec.geometry.radius_mm.abs().max(1e-6);
        let center = spec.transform.position_mm.add(rotation.mul(Vec3::new(
            0.0,
            0.0,
            spec.geometry.radius_mm,
        )));
        bounds = bounds
            .include(center.sub(Vec3::new(r, r, r)))
            .include(center.add(Vec3::new(r, r, r)));
    } else {
        let half_w = if spec.aperture.kind == "circle" {
            spec.aperture.radius_mm
        } else {
            spec.aperture.width_mm * 0.5
        }
        .abs()
        .max(1e-4);
        let half_h = if spec.aperture.kind == "circle" {
            spec.aperture.radius_mm
        } else {
            spec.aperture.height_mm * 0.5
        }
        .abs()
        .max(1e-4);
        for &x in &[-half_w, half_w] {
            for &y in &[-half_h, half_h] {
                for &z in &[-1e-6, 1e-6] {
                    bounds = bounds.include(
                        spec.transform
                            .position_mm
                            .add(rotation.mul(Vec3::new(x, y, z))),
                    );
                }
            }
        }
    }
    PreparedSurface {
        spec,
        rotation,
        bounds,
    }
}

fn build_bvh(indices: &mut [usize], surfaces: &[PreparedSurface]) -> BvhNode {
    let bounds = indices.iter().fold(Bounds::empty(), |acc, index| {
        acc.union(surfaces[*index].bounds)
    });
    if indices.len() <= 8 {
        return BvhNode::Leaf {
            bounds,
            indices: indices.to_vec(),
        };
    }
    let extent = bounds.extent();
    let axis = if extent.x >= extent.y && extent.x >= extent.z {
        0
    } else if extent.y >= extent.z {
        1
    } else {
        2
    };
    indices.sort_by(|a, b| {
        surfaces[*a]
            .bounds
            .centroid()
            .axis(axis)
            .partial_cmp(&surfaces[*b].bounds.centroid().axis(axis))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let middle = indices.len() / 2;
    let (left, right) = indices.split_at_mut(middle);
    BvhNode::Branch {
        bounds,
        left: Box::new(build_bvh(left, surfaces)),
        right: Box::new(build_bvh(right, surfaces)),
    }
}

fn ray_intersects_bounds(origin: Vec3, direction: Vec3, bounds: Bounds, max_t: f64) -> bool {
    let mut t_min: f64 = 0.0;
    let mut t_max: f64 = max_t;
    for axis in 0..3 {
        let o = origin.axis(axis);
        let d = direction.axis(axis);
        let min = bounds.min.axis(axis);
        let max = bounds.max.axis(axis);
        if d.abs() < 1e-15 {
            if o < min || o > max {
                return false;
            }
        } else {
            let mut a = (min - o) / d;
            let mut b = (max - o) / d;
            if a > b {
                std::mem::swap(&mut a, &mut b);
            }
            t_min = t_min.max(a);
            t_max = t_max.min(b);
            if t_max < t_min {
                return false;
            }
        }
    }
    true
}

fn aperture_accepts(aperture: &ApertureSpec, point: Vec3) -> bool {
    if aperture.kind == "circle" {
        let radius = aperture.radius_mm.abs();
        radius <= 0.0 || point.x * point.x + point.y * point.y <= radius * radius + 1e-12
    } else {
        let half_w = aperture.width_mm.abs() * 0.5;
        let half_h = aperture.height_mm.abs() * 0.5;
        (half_w <= 0.0 || point.x.abs() <= half_w + 1e-12)
            && (half_h <= 0.0 || point.y.abs() <= half_h + 1e-12)
    }
}

fn target_height_and_slope(profile: &TargetProfileSpec, x_mm: f64) -> (f64, f64) {
    let offset = profile.offset_um * 1e-3;
    let amplitude = profile.amplitude_um * 1e-3;
    match profile.kind.as_str() {
        "step" => (
            offset
                + if x_mm >= profile.step_position_mm {
                    amplitude
                } else {
                    0.0
                },
            0.0,
        ),
        "tilt" => {
            // Match the Design Intent/Web definition: amplitude is the height
            // excursion from the center to either edge, not a slope unit.
            let half_span = if profile.span_mm.abs() > 1e-12 {
                profile.span_mm.abs() * 0.5
            } else {
                1.0
            };
            (offset + amplitude * x_mm / half_span, amplitude / half_span)
        }
        "sine" => {
            let period = profile.period_mm.abs().max(1e-12);
            let phase = 2.0 * PI * x_mm / period;
            (
                offset + amplitude * phase.sin(),
                amplitude * 2.0 * PI / period * phase.cos(),
            )
        }
        "csv" if profile.csv_points.len() >= 2 => {
            let mut left = profile.csv_points[0];
            let mut right = profile.csv_points[profile.csv_points.len() - 1];
            for pair in profile.csv_points.windows(2) {
                if x_mm >= pair[0][0] && x_mm <= pair[1][0] {
                    left = pair[0];
                    right = pair[1];
                    break;
                }
            }
            let dx = right[0] - left[0];
            let slope = if dx.abs() > 1e-15 {
                (right[1] - left[1]) * 1e-3 / dx
            } else {
                0.0
            };
            (left[1] * 1e-3 + slope * (x_mm - left[0]), slope)
        }
        _ => (offset, 0.0),
    }
}

fn intersect_surface(
    surface: &PreparedSurface,
    ray: &RayState,
    epsilon: f64,
) -> Option<(f64, Vec3, Vec3, f64)> {
    let local_origin = surface.local_point(ray.position);
    let local_direction = surface.local_vector(ray.direction).normalized();
    let kind = surface.spec.geometry.kind.as_str();
    let (t, point, mut normal) = if kind == "sphere" {
        let radius = surface.spec.geometry.radius_mm;
        if radius.abs() < 1e-12 {
            return None;
        }
        let center = Vec3::new(0.0, 0.0, radius);
        let oc = local_origin.sub(center);
        let b = oc.dot(local_direction);
        let c = oc.dot(oc) - radius * radius;
        let disc = b * b - c;
        if disc < 0.0 {
            return None;
        }
        let root = disc.sqrt();
        let candidates = [-b - root, -b + root];
        let t = candidates
            .into_iter()
            .filter(|value| *value > epsilon)
            .fold(f64::INFINITY, f64::min);
        if !t.is_finite() {
            return None;
        }
        let point = local_origin.add(local_direction.scale(t));
        (t, point, point.sub(center).normalized())
    } else if kind == "triangle" {
        let a = surface.spec.geometry.vertex_a;
        let b = surface.spec.geometry.vertex_b;
        let c = surface.spec.geometry.vertex_c;
        let edge1 = b.sub(a);
        let edge2 = c.sub(a);
        let h = local_direction.cross(edge2);
        let det = edge1.dot(h);
        if det.abs() < 1e-12 {
            return None;
        }
        let inv = 1.0 / det;
        let s = local_origin.sub(a);
        let u = inv * s.dot(h);
        if !(0.0..=1.0).contains(&u) {
            return None;
        }
        let q = s.cross(edge1);
        let v = inv * local_direction.dot(q);
        if v < 0.0 || u + v > 1.0 {
            return None;
        }
        let t = inv * edge2.dot(q);
        if t <= epsilon {
            return None;
        }
        (
            t,
            local_origin.add(local_direction.scale(t)),
            edge1.cross(edge2).normalized(),
        )
    } else if kind == "profile" {
        let profile = surface.spec.geometry.target_profile.as_ref()?;
        let mut t = if local_direction.z.abs() > 1e-15 {
            -local_origin.z / local_direction.z
        } else {
            return None;
        };
        for _ in 0..16 {
            let point = local_origin.add(local_direction.scale(t));
            let (height, slope) = target_height_and_slope(profile, point.x);
            let f = point.z - height;
            let derivative = local_direction.z - slope * local_direction.x;
            if derivative.abs() < 1e-15 {
                break;
            }
            t -= f / derivative;
            if f.abs() < 1e-10 {
                break;
            }
        }
        if t <= epsilon {
            return None;
        }
        let point = local_origin.add(local_direction.scale(t));
        let (_, slope) = target_height_and_slope(profile, point.x);
        (t, point, Vec3::new(-slope, 0.0, 1.0).normalized())
    } else {
        if local_direction.z.abs() < 1e-15 {
            return None;
        }
        let t = -local_origin.z / local_direction.z;
        if t <= epsilon {
            return None;
        }
        (
            t,
            local_origin.add(local_direction.scale(t)),
            Vec3::new(0.0, 0.0, 1.0),
        )
    };
    if !aperture_accepts(&surface.spec.aperture, point) {
        return None;
    }
    if normal.dot(local_direction) > 0.0 {
        normal = normal.scale(-1.0);
    }
    Some((
        t,
        point,
        surface.world_vector(normal).normalized(),
        local_direction.z,
    ))
}

fn query_nearest(
    node: &BvhNode,
    surfaces: &[PreparedSurface],
    ray: &RayState,
    epsilon: f64,
    best: &mut Option<Hit>,
) {
    let max_t = best.as_ref().map(|hit| hit.t).unwrap_or(f64::INFINITY);
    if !ray_intersects_bounds(ray.position, ray.direction, node.bounds(), max_t) {
        return;
    }
    match node {
        BvhNode::Leaf { indices, .. } => {
            for index in indices {
                if let Some((t, point_local, normal_world, local_dir_z)) =
                    intersect_surface(&surfaces[*index], ray, epsilon)
                {
                    if t < best.as_ref().map(|hit| hit.t).unwrap_or(f64::INFINITY) {
                        let point_world = ray.position.add(ray.direction.scale(t));
                        *best = Some(Hit {
                            surface_index: *index,
                            t,
                            point_world,
                            point_local,
                            normal_world,
                            local_dir_z,
                        });
                    }
                }
            }
        }
        BvhNode::Branch { left, right, .. } => {
            query_nearest(left, surfaces, ray, epsilon, best);
            query_nearest(right, surfaces, ray, epsilon, best);
        }
    }
}

fn reflect(direction: Vec3, normal: Vec3) -> Vec3 {
    direction
        .sub(normal.scale(2.0 * direction.dot(normal)))
        .normalized()
}

fn refract(direction: Vec3, mut normal: Vec3, n1: f64, n2: f64) -> Option<Vec3> {
    let mut cos_i = -normal.dot(direction);
    if cos_i < 0.0 {
        normal = normal.scale(-1.0);
        cos_i = -normal.dot(direction);
    }
    let eta = n1 / n2;
    let k = 1.0 - eta * eta * (1.0 - cos_i * cos_i);
    if k < 0.0 {
        None
    } else {
        Some(
            direction
                .scale(eta)
                .add(normal.scale(eta * cos_i - k.sqrt()))
                .normalized(),
        )
    }
}

fn fresnel_unpolarized(direction: Vec3, normal: Vec3, n1: f64, n2: f64) -> f64 {
    let cos_i = (-normal.dot(direction)).abs().min(1.0);
    let sin_t2 = (n1 / n2).powi(2) * (1.0 - cos_i * cos_i);
    if sin_t2 >= 1.0 {
        return 1.0;
    }
    let cos_t = (1.0 - sin_t2).sqrt();
    let rs = (n1 * cos_i - n2 * cos_t) / (n1 * cos_i + n2 * cos_t);
    let rp = (n2 * cos_i - n1 * cos_t) / (n2 * cos_i + n1 * cos_t);
    clamp01(0.5 * (rs * rs + rp * rp))
}

fn cauchy_index_from_nd_vd(nd: f64, vd: f64, wavelength_nm: f64) -> f64 {
    let nd = nd.max(1.0);
    if vd <= 0.0 || wavelength_nm <= 0.0 {
        return nd;
    }
    let lambda_f_um: f64 = 0.486_132_7;
    let lambda_d_um: f64 = 0.587_561_8;
    let lambda_c_um: f64 = 0.656_272_5;
    let dispersion = (nd - 1.0) / vd;
    let denominator = 1.0 / lambda_f_um.powi(2) - 1.0 / lambda_c_um.powi(2);
    if denominator.abs() <= 1e-18 {
        return nd;
    }
    let b = dispersion / denominator;
    let a = nd - b / lambda_d_um.powi(2);
    let lambda_um = wavelength_nm * 1e-3;
    (a + b / lambda_um.powi(2)).max(1.0)
}

fn beam_splitter_plate_equivalent(
    direction: Vec3,
    normal: Vec3,
    thickness_mm: f64,
    substrate_n: f64,
) -> (Vec3, f64) {
    let thickness = thickness_mm.max(0.0);
    let n = substrate_n.max(1.0);
    if thickness <= 0.0 || n <= 1.0 {
        return (Vec3::default(), 0.0);
    }
    let cos_i = direction.dot(normal).abs().clamp(1e-12, 1.0);
    let Some(inside_direction) = refract(direction, normal, 1.0, n) else {
        return (Vec3::default(), 0.0);
    };
    let travel_normal = if direction.dot(normal) >= 0.0 {
        normal
    } else {
        normal.scale(-1.0)
    };
    let cos_t = inside_direction.dot(travel_normal).abs().clamp(1e-12, 1.0);
    let air_distance = thickness / cos_i;
    let glass_distance = thickness / cos_t;
    let lateral_shift = inside_direction
        .scale(glass_distance)
        .sub(direction.scale(air_distance));
    let excess_opl_mm = (n * glass_distance - air_distance).max(0.0);
    (lateral_shift, excess_opl_mm)
}

fn apply_thin_lens(
    surface: &PreparedSurface,
    ray: &RayState,
    hit: &Hit,
    interaction: &InteractionSpec,
) -> Vec3 {
    let local_dir = surface.local_vector(ray.direction);
    let fx = if interaction.focal_length_x_mm.abs() > 1e-12 {
        interaction.focal_length_x_mm
    } else {
        f64::INFINITY
    };
    let fy = if interaction.focal_length_y_mm.abs() > 1e-12 {
        interaction.focal_length_y_mm
    } else {
        fx
    };
    let sign = if local_dir.z >= 0.0 { 1.0 } else { -1.0 };
    let out = Vec3::new(
        local_dir.x
            - if fx.is_finite() {
                sign * hit.point_local.x / fx
            } else {
                0.0
            },
        local_dir.y
            - if fy.is_finite() {
                sign * hit.point_local.y / fy
            } else {
                0.0
            },
        local_dir.z,
    )
    .normalized();
    surface.world_vector(out).normalized()
}

fn grating_direction(
    surface: &PreparedSurface,
    ray: &RayState,
    hit: &Hit,
    order: i32,
    density: f64,
    groove_direction: Vec3,
) -> Option<(Vec3, f64)> {
    let input = surface.local_vector(ray.direction).normalized();
    let groove_tangent = Vec3::new(groove_direction.x, groove_direction.y, 0.0);
    let groove = if groove_tangent.norm() > 1e-12 {
        groove_tangent.normalized()
    } else {
        Vec3::new(0.0, 1.0, 0.0)
    };
    let grating_axis = groove.cross(Vec3::new(0.0, 0.0, 1.0)).normalized();
    let wavelength_mm = ray.wavelength_nm * 1e-6;
    let output_tangent = Vec3::new(input.x, input.y, 0.0)
        .add(grating_axis.scale(order as f64 * wavelength_mm * density));
    let transverse2 = output_tangent.x * output_tangent.x + output_tangent.y * output_tangent.y;
    if transverse2 > 1.0 + 1e-12 {
        return None;
    }
    let out_z = -input.z.signum() * (1.0 - transverse2.min(1.0)).sqrt();
    let groove_coordinate_mm = hit.point_local.dot(grating_axis);
    let phase = 2.0 * PI * order as f64 * density * groove_coordinate_mm;
    Some((
        surface
            .world_vector(Vec3::new(output_tangent.x, output_tangent.y, out_z))
            .normalized(),
        phase,
    ))
}

fn grating_complex_response(
    interaction: &InteractionSpec,
    order: i32,
    wavelength_nm: f64,
    fallback_power: f64,
) -> (f64, f64) {
    let mut lower: Option<&ComplexEfficiencySpec> = None;
    let mut upper: Option<&ComplexEfficiencySpec> = None;
    for entry in interaction
        .complex_efficiency
        .iter()
        .filter(|entry| entry.order == order)
    {
        if entry.wavelength_nm <= wavelength_nm
            && lower.map_or(true, |current| entry.wavelength_nm > current.wavelength_nm)
        {
            lower = Some(entry);
        }
        if entry.wavelength_nm >= wavelength_nm
            && upper.map_or(true, |current| entry.wavelength_nm < current.wavelength_nm)
        {
            upper = Some(entry);
        }
    }
    match (lower, upper) {
        (Some(left), Some(right)) => {
            let span = right.wavelength_nm - left.wavelength_nm;
            let fraction = if span.abs() > 1e-12 {
                (wavelength_nm - left.wavelength_nm) / span
            } else {
                0.0
            };
            let amplitude = left.amplitude + (right.amplitude - left.amplitude) * fraction;
            let phase_deg = left.phase_deg + (right.phase_deg - left.phase_deg) * fraction;
            (clamp01(amplitude * amplitude), phase_deg * PI / 180.0)
        }
        (Some(entry), None) | (None, Some(entry)) => (
            clamp01(entry.amplitude * entry.amplitude),
            entry.phase_deg * PI / 180.0,
        ),
        (None, None) => (clamp01(fallback_power), 0.0),
    }
}

fn generate_spectrum(source: &SourceSpec) -> Vec<SpectrumLine> {
    let spec = &source.spectrum;
    let mut lines = Vec::new();
    let center_frequency = C_M_PER_S / (spec.center_wavelength_nm.max(1e-9) * 1e-9);
    let delay_seconds = spec.relative_delay_fs * 1e-15;
    if spec.kind == "frequency-comb" || spec.kind == "comb" {
        let repetition = spec.repetition_rate_hz.abs().max(1.0);
        let ceo = spec.ceo_frequency_hz.rem_euclid(repetition);
        let center_index = ((center_frequency - ceo) / repetition).round() as i64;
        let count = spec.line_count.max(1).min(100_001);
        let half = (count as i64 - 1) / 2;
        for relative in 0..count as i64 {
            let index = center_index + relative - half;
            let frequency = ceo + index as f64 * repetition;
            if frequency <= 0.0 {
                continue;
            }
            let wavelength = C_M_PER_S / frequency * 1e9;
            let delta = wavelength - spec.center_wavelength_nm;
            let sigma = spec.bandwidth_fwhm_nm.abs().max(1e-12) / 2.354_820_045;
            let weight = (-0.5 * (delta / sigma).powi(2)).exp();
            let angular_detuning = 2.0 * PI * (frequency - center_frequency);
            let phase = spec.initial_phase_rad
                + angular_detuning * delay_seconds
                + 0.5 * spec.group_delay_dispersion_fs2 * 1e-30 * angular_detuning.powi(2);
            lines.push(SpectrumLine {
                source_id: source.id.clone(),
                coherence_group_id: source.coherence_group_id.clone(),
                line_index: index,
                frequency_hz: frequency,
                wavelength_nm: wavelength,
                weight,
                initial_phase_rad: phase,
            });
        }
    } else {
        let count = spec.spectral_samples.max(1).min(4097);
        let min = if spec.min_wavelength_nm > 0.0 {
            spec.min_wavelength_nm
        } else {
            spec.center_wavelength_nm - spec.bandwidth_fwhm_nm
        };
        let max = if spec.max_wavelength_nm > min {
            spec.max_wavelength_nm
        } else {
            spec.center_wavelength_nm + spec.bandwidth_fwhm_nm
        };
        for index in 0..count {
            let fraction = if count == 1 {
                0.5
            } else {
                index as f64 / (count - 1) as f64
            };
            let wavelength = min + (max - min) * fraction;
            let frequency = C_M_PER_S / (wavelength * 1e-9);
            let sigma = spec.bandwidth_fwhm_nm.abs().max(1e-12) / 2.354_820_045;
            let delta = wavelength - spec.center_wavelength_nm;
            let weight = if spec.shape == "flat" {
                1.0
            } else {
                (-0.5 * (delta / sigma).powi(2)).exp()
            };
            let phase =
                spec.initial_phase_rad + 2.0 * PI * (frequency - center_frequency) * delay_seconds;
            lines.push(SpectrumLine {
                source_id: source.id.clone(),
                coherence_group_id: source.coherence_group_id.clone(),
                line_index: index as i64,
                frequency_hz: frequency,
                wavelength_nm: wavelength,
                weight,
                initial_phase_rad: phase,
            });
        }
    }
    let sum: f64 = lines.iter().map(|line| line.weight).sum();
    if sum > 0.0 {
        for line in &mut lines {
            line.weight /= sum;
        }
    }
    lines
}

fn generate_source_rays(
    source: &SourceSpec,
    next_id: &mut u64,
) -> (Vec<RayState>, Vec<SpectrumLineResult>) {
    let rotation = Mat3::from_euler(source.transform.rotation_deg);
    let spectrum = generate_spectrum(source);
    let spatial_target = source.spatial_samples.max(1);
    let side = (spatial_target as f64).sqrt().ceil() as usize;
    let mut samples = Vec::new();
    for iy in 0..side {
        for ix in 0..side {
            let x_norm = if side == 1 {
                0.0
            } else {
                2.0 * ix as f64 / (side - 1) as f64 - 1.0
            };
            let y_norm = if side == 1 {
                0.0
            } else {
                2.0 * iy as f64 / (side - 1) as f64 - 1.0
            };
            if x_norm * x_norm + y_norm * y_norm > 1.0 + 1e-12 {
                continue;
            }
            let radial2 = x_norm * x_norm + y_norm * y_norm;
            let weight = if source.spatial_profile == "top-hat" {
                1.0
            } else {
                (-2.0 * radial2).exp()
            };
            samples.push((x_norm, y_norm, weight));
            if samples.len() >= spatial_target {
                break;
            }
        }
        if samples.len() >= spatial_target {
            break;
        }
    }
    if samples.is_empty() {
        samples.push((0.0, 0.0, 1.0));
    }
    let spatial_sum: f64 = samples.iter().map(|sample| sample.2).sum();
    let mut rays = Vec::new();
    let mut line_results = Vec::new();
    for line in spectrum {
        let line_power = source.total_power_w.max(0.0) * line.weight;
        line_results.push(SpectrumLineResult {
            source_id: source.id.clone(),
            line_index: line.line_index,
            frequency_hz: line.frequency_hz,
            wavelength_nm: line.wavelength_nm,
            power_w: line_power,
        });
        for &(x_norm, y_norm, spatial_weight) in &samples {
            let radius = source.beam_diameter_mm.max(0.0) * 0.5;
            let local_position = Vec3::new(x_norm * radius, y_norm * radius, 0.0);
            let divergence = source.divergence_deg * PI / 180.0;
            let local_direction = Vec3::new(
                (x_norm * divergence).tan(),
                (y_norm * divergence).tan(),
                1.0,
            )
            .normalized();
            let power = line_power * spatial_weight / spatial_sum.max(1e-30);
            rays.push(RayState {
                id: *next_id,
                parent_id: None,
                source_id: source.id.clone(),
                coherence_group_id: if source.coherence_group_id.is_empty() {
                    source.id.clone()
                } else {
                    source.coherence_group_id.clone()
                },
                line_index: line.line_index,
                frequency_hz: line.frequency_hz,
                wavelength_nm: line.wavelength_nm,
                position: source
                    .transform
                    .position_mm
                    .add(rotation.mul(local_position)),
                direction: rotation.mul(local_direction).normalized(),
                amplitude: Complex::from_power(power).rotate(line.initial_phase_rad),
                medium_n: 1.0,
                opl_mm: 0.0,
                interactions: 0,
                history: Vec::new(),
            });
            *next_id += 1;
        }
    }
    (rays, line_results)
}

fn detector_pixel(
    detector: &DetectorSpec,
    surface: &PreparedSurface,
    hit: &Hit,
) -> Option<(usize, usize)> {
    if detector.front_only && hit.local_dir_z >= 0.0 {
        return None;
    }
    if detector.kind == "time" {
        return Some((0, 0));
    }
    let pitch_mm = detector.pixel_pitch_um.max(1e-9) * 1e-3;
    let width_mm = detector.pixel_count_x as f64 * pitch_mm;
    let height_mm = detector.pixel_count_y as f64 * pitch_mm;
    let x_float = (hit.point_local.x + width_mm * 0.5) / pitch_mm;
    let y_float = (hit.point_local.y + height_mm * 0.5) / pitch_mm;
    if x_float < 0.0
        || y_float < 0.0
        || x_float >= detector.pixel_count_x as f64
        || y_float >= detector.pixel_count_y as f64
    {
        return None;
    }
    let px = x_float.floor() as usize;
    let py = y_float.floor() as usize;
    let fill = clamp01(detector.fill_factor).sqrt();
    let local_x = x_float.fract() - 0.5;
    let local_y = y_float.fract() - 0.5;
    if local_x.abs() > fill * 0.5 || local_y.abs() > fill * 0.5 {
        return None;
    }
    let _ = surface;
    Some((px, py))
}

fn bsdf_sample_value(samples: &[BsdfSampleSpec], angle_deg: f64) -> f64 {
    let mut points: Vec<(f64, f64)> = samples
        .iter()
        .filter(|sample| {
            sample.angle_deg.is_finite() && sample.value.is_finite() && sample.value >= 0.0
        })
        .map(|sample| (sample.angle_deg.max(0.0), sample.value))
        .collect();
    points.sort_by(|left, right| {
        left.0
            .partial_cmp(&right.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if points.is_empty() {
        return 0.0;
    }
    if angle_deg <= points[0].0 {
        return points[0].1;
    }
    if angle_deg >= points[points.len() - 1].0 {
        return points[points.len() - 1].1;
    }
    for index in 1..points.len() {
        let left = points[index - 1];
        let right = points[index];
        if angle_deg > right.0 {
            continue;
        }
        let t = (angle_deg - left.0) / (right.0 - left.0).max(1e-15);
        return left.1 + (right.1 - left.1) * t;
    }
    0.0
}

fn target_scatter_directions(
    direction: Vec3,
    normal: Vec3,
    interaction: &InteractionSpec,
) -> Vec<(Vec3, f64)> {
    let specular = reflect(direction, normal);
    let model = interaction.scatter_model.as_str();
    if model.is_empty() || model == "specular" {
        return vec![(specular, clamp01(interaction.reflectivity))];
    }
    let count = interaction.scatter_samples.max(1).min(128);
    let oriented_normal = if specular.dot(normal) >= 0.0 {
        normal
    } else {
        normal.scale(-1.0)
    }
    .normalized();
    let axis = if model == "lambertian" {
        oriented_normal
    } else {
        specular
    };
    let reference = if axis.z.abs() < 0.9 {
        Vec3::new(0.0, 0.0, 1.0)
    } else {
        Vec3::new(1.0, 0.0, 0.0)
    };
    let tangent = reference.cross(axis).normalized();
    let bitangent = axis.cross(tangent).normalized();
    let sigma_rad = interaction.scatter_sigma_deg.max(1e-6).to_radians();
    let max_theta = 80.0_f64.to_radians();
    let mut candidates: Vec<(Vec3, f64)> = Vec::with_capacity(count);
    for index in 0..count {
        let u = (index as f64 + 0.5) / count as f64;
        let v = ((index as f64 + 0.5) * 0.618_033_988_749_894_9).fract();
        let (sin_theta, cos_theta, angle_rad) = if model == "lambertian" {
            let sin_theta = u.sqrt();
            let cos_theta = (1.0 - u).sqrt();
            (sin_theta, cos_theta, sin_theta.asin())
        } else if model == "harvey-shack" {
            let theta = (sigma_rad * (-2.0 * (1.0 - 0.999 * u).ln()).sqrt()).min(max_theta);
            (theta.sin(), theta.cos(), theta)
        } else {
            let theta = max_theta * u.sqrt();
            (theta.sin(), theta.cos(), theta)
        };
        let phi = 2.0 * PI * v;
        let sample_direction = axis
            .scale(cos_theta)
            .add(tangent.scale(sin_theta * phi.cos()))
            .add(bitangent.scale(sin_theta * phi.sin()))
            .normalized();
        if sample_direction.dot(oriented_normal) <= 0.0 {
            continue;
        }
        let angle_deg = angle_rad.to_degrees();
        let weight = match model {
            "lambertian" => 1.0,
            "abg" => {
                interaction.scatter_a.max(0.0)
                    / (interaction.scatter_b.max(1e-12) + angle_rad.abs())
                        .powf(interaction.scatter_g.max(1e-6))
            }
            "harvey-shack" => (-0.5 * (angle_rad / sigma_rad).powi(2)).exp(),
            "bsdf-csv" => bsdf_sample_value(&interaction.bsdf_samples, angle_deg),
            _ => 1.0,
        };
        if weight.is_finite() && weight > 0.0 {
            candidates.push((sample_direction, weight));
        }
    }
    if candidates.is_empty() {
        return vec![(specular, clamp01(interaction.reflectivity))];
    }
    let weight_sum: f64 = candidates.iter().map(|entry| entry.1).sum();
    let reflected_power = clamp01(interaction.reflectivity);
    candidates
        .into_iter()
        .map(|(sample_direction, weight)| {
            (
                sample_direction,
                reflected_power * weight / weight_sum.max(1e-30),
            )
        })
        .collect()
}
fn child_ray(
    parent: &RayState,
    id: u64,
    point: Vec3,
    direction: Vec3,
    epsilon: f64,
    power_scale: f64,
    phase_rad: f64,
    history: String,
) -> RayState {
    let mut child = parent.clone();
    child.id = id;
    child.parent_id = Some(parent.id);
    child.position = point.add(direction.scale(epsilon));
    child.direction = direction.normalized();
    child.amplitude = parent.amplitude.scale_phase(power_scale, phase_rad);
    child.interactions += 1;
    child.history.push(history);
    child
}

fn aggregate_detectors(
    detectors: &[DetectorSpec],
    contributions: &[DetectorContribution],
) -> Vec<DetectorResult> {
    let mut output = Vec::new();
    for detector in detectors {
        let width = if detector.kind == "time" {
            1
        } else {
            detector.pixel_count_x.max(1)
        };
        let height = if detector.kind == "time" {
            1
        } else {
            detector.pixel_count_y.max(1)
        };
        let relevant: Vec<&DetectorContribution> = contributions
            .iter()
            .filter(|item| item.detector_id == detector.id)
            .collect();
        let mut spectral_fields: HashMap<(usize, usize, String, u64), (Complex, f64)> =
            HashMap::new();
        for item in &relevant {
            let key = (
                item.pixel_x,
                item.pixel_y,
                item.coherence_group_id.clone(),
                item.frequency_hz.to_bits(),
            );
            let current = spectral_fields
                .get(&key)
                .copied()
                .unwrap_or((Complex { re: 0.0, im: 0.0 }, item.wavelength_nm));
            spectral_fields.insert(key, (current.0.add(item.field), item.wavelength_nm));
        }
        let mut intensity = vec![0.0; width * height];
        let mut spectral_field_results = Vec::with_capacity(spectral_fields.len());
        for ((px, py, coherence_group_id, frequency_bits), (field, wavelength_nm)) in
            &spectral_fields
        {
            let index = py.saturating_mul(width).saturating_add(*px);
            if index < intensity.len() {
                intensity[index] += field.norm2() * detector.responsivity.max(0.0);
                spectral_field_results.push(DetectorSpectralFieldResult {
                    pixel_x: *px,
                    pixel_y: *py,
                    coherence_group_id: coherence_group_id.clone(),
                    frequency_hz: f64::from_bits(*frequency_bits),
                    wavelength_nm: *wavelength_nm,
                    field_re: field.re,
                    field_im: field.im,
                });
            }
        }
        spectral_field_results.sort_by(|left, right| {
            left.frequency_hz
                .partial_cmp(&right.frequency_hz)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.coherence_group_id.cmp(&right.coherence_group_id))
                .then_with(|| left.pixel_y.cmp(&right.pixel_y))
                .then_with(|| left.pixel_x.cmp(&right.pixel_x))
        });
        let integrated: f64 = intensity.iter().sum();
        let maximum = intensity.iter().copied().fold(0.0_f64, f64::max);
        let mut time_seconds = Vec::new();
        let mut time_signal_w = Vec::new();
        let mut rf_beats = Vec::new();
        if detector.kind == "time" {
            let mut source_fields: HashMap<(String, i64), (f64, Complex)> = HashMap::new();
            for item in &relevant {
                let key = (item.source_id.clone(), item.line_index);
                let current = source_fields
                    .get(&key)
                    .copied()
                    .unwrap_or((item.frequency_hz, Complex { re: 0.0, im: 0.0 }));
                source_fields.insert(key, (item.frequency_hz, current.1.add(item.field)));
            }
            let mut source_ids: Vec<String> =
                relevant.iter().map(|item| item.source_id.clone()).collect();
            source_ids.sort();
            source_ids.dedup();
            if source_ids.len() >= 2 {
                let collect_modes = |source_id: &String| {
                    let mut modes: Vec<(i64, f64, Complex)> = source_fields
                        .iter()
                        .filter(|((source, _), _)| source == source_id)
                        .map(|((_, line), (frequency, field))| (*line, *frequency, *field))
                        .collect();
                    modes.sort_by(|left, right| {
                        left.1
                            .partial_cmp(&right.1)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    modes
                };
                let first_modes = collect_modes(&source_ids[0]);
                let second_modes = collect_modes(&source_ids[1]);
                for (first, second) in first_modes.iter().zip(second_modes.iter()) {
                    let cross = first.2.mul_conj(second.2);
                    rf_beats.push(RfBeatResult {
                        line_index: first.0,
                        frequency_hz: (first.1 - second.1).abs(),
                        power_w: 2.0 * cross.norm2().sqrt(),
                    });
                }
            }
            let count = detector.sample_count.max(2).min(1_000_000);
            let sample_rate = detector.sampling_rate_hz.max(1.0);
            for index in 0..count {
                let time = index as f64 / sample_rate;
                let mut signal = relevant.iter().map(|item| item.ray_power_w).sum::<f64>();
                for beat in &rf_beats {
                    signal += beat.power_w * (2.0 * PI * beat.frequency_hz * time).cos();
                }
                time_seconds.push(time);
                time_signal_w.push(signal.max(0.0));
            }
        }
        output.push(DetectorResult {
            detector_id: detector.id.clone(),
            kind: detector.kind.clone(),
            width,
            height,
            intensity_w_per_pixel: intensity,
            integrated_power_w: integrated,
            maximum_w_per_pixel: maximum,
            hit_count: relevant.len(),
            spectral_fields: spectral_field_results,
            time_seconds,
            time_signal_w,
            rf_beats,
        });
    }
    output
}

pub fn trace_nonsequential(request: &TraceRequest) -> Result<TraceResult, String> {
    if request.surfaces.is_empty() {
        return Err("non-sequential scene contains no optical surfaces".to_string());
    }
    if request.sources.is_empty() {
        return Err("non-sequential scene contains no light source".to_string());
    }
    let surfaces: Vec<PreparedSurface> = request
        .surfaces
        .clone()
        .into_iter()
        .map(prepare_surface)
        .collect();
    let mut indices: Vec<usize> = (0..surfaces.len()).collect();
    let bvh = build_bvh(&mut indices, &surfaces);
    let detector_by_id: HashMap<String, &DetectorSpec> = request
        .detectors
        .iter()
        .map(|detector| (detector.id.clone(), detector))
        .collect();
    let mut next_id = 1_u64;
    let mut queue = VecDeque::new();
    let mut spectrum_lines = Vec::new();
    let mut energy = EnergySummary::default();
    for source in &request.sources {
        let (rays, lines) = generate_source_rays(source, &mut next_id);
        energy.emitted_power_w += source.total_power_w.max(0.0);
        queue.extend(rays);
        spectrum_lines.extend(lines);
    }
    let emitted = energy.emitted_power_w.max(1e-30);
    let mut segments = Vec::new();
    let mut contributions = Vec::new();
    let mut terminated = 0_usize;
    let mut warnings: Vec<String> = Vec::new();
    let mut generated = queue.len();
    while let Some(mut ray) = queue.pop_front() {
        let power = ray.amplitude.norm2();
        if power / emitted < request.settings.min_relative_power {
            energy.truncated_power_w += power;
            terminated += 1;
            continue;
        }
        if ray.interactions >= request.settings.max_interactions {
            energy.truncated_power_w += power;
            terminated += 1;
            continue;
        }
        let mut hit = None;
        query_nearest(
            &bvh,
            &surfaces,
            &ray,
            request.settings.ray_epsilon_mm.max(1e-12),
            &mut hit,
        );
        let Some(hit) = hit else {
            energy.escaped_power_w += power;
            terminated += 1;
            continue;
        };
        let surface = &surfaces[hit.surface_index];
        let segment_length = hit.point_world.sub(ray.position).norm();
        ray.opl_mm += segment_length * ray.medium_n.max(1e-12);
        if segments.len() < request.settings.render_segment_limit {
            segments.push(RaySegmentResult {
                ray_id: ray.id,
                parent_ray_id: ray.parent_id,
                start_mm: ray.position,
                end_mm: hit.point_world,
                wavelength_nm: ray.wavelength_nm,
                power_w: power,
                surface_id: surface.spec.id.clone(),
                history: ray.history.join(" > "),
            });
        }
        let interaction = &surface.spec.interaction;
        let epsilon = request.settings.ray_epsilon_mm.max(1e-12);
        let mut children = Vec::new();
        match interaction.kind.as_str() {
            "detector" => {
                let detector_id = if interaction.detector_id.is_empty() {
                    surface.spec.component_id.clone()
                } else {
                    interaction.detector_id.clone()
                };
                if let Some(detector) = detector_by_id.get(&detector_id) {
                    if let Some((pixel_x, pixel_y)) = detector_pixel(detector, surface, &hit) {
                        let phase = 2.0 * PI * ray.opl_mm / (ray.wavelength_nm * 1e-6).max(1e-18);
                        let field = ray.amplitude.rotate(phase);
                        contributions.push(DetectorContribution {
                            detector_id,
                            pixel_x,
                            pixel_y,
                            source_id: ray.source_id.clone(),
                            coherence_group_id: ray.coherence_group_id.clone(),
                            line_index: ray.line_index,
                            frequency_hz: ray.frequency_hz,
                            wavelength_nm: ray.wavelength_nm,
                            field,
                            ray_power_w: power,
                            history: ray.history.join(" > "),
                        });
                        energy.detected_ray_power_w += power;
                    } else {
                        energy.absorbed_power_w += power;
                    }
                } else {
                    energy.absorbed_power_w += power;
                }
                terminated += 1;
            }
            "mirror" => {
                let direction = reflect(ray.direction, hit.normal_world);
                children.push(child_ray(
                    &ray,
                    next_id,
                    hit.point_world,
                    direction,
                    epsilon,
                    clamp01(interaction.reflectivity),
                    interaction.phase_deg * PI / 180.0,
                    format!("{}:R", surface.spec.id),
                ));
                next_id += 1;
            }
            "target" => {
                let scattered = !interaction.scatter_model.is_empty()
                    && interaction.scatter_model != "specular";
                for (direction, power_scale) in
                    target_scatter_directions(ray.direction, hit.normal_world, interaction)
                {
                    let child_id = next_id;
                    let mut child = child_ray(
                        &ray,
                        child_id,
                        hit.point_world,
                        direction,
                        epsilon,
                        power_scale,
                        interaction.phase_deg * PI / 180.0,
                        format!("{}:{}", surface.spec.id, if scattered { "S" } else { "R" }),
                    );
                    if scattered {
                        child.coherence_group_id =
                            format!("{}:scatter:{}", ray.coherence_group_id, child_id);
                    }
                    children.push(child);
                    next_id += 1;
                }
            }
            "attenuator" => {
                children.push(child_ray(
                    &ray,
                    next_id,
                    hit.point_world,
                    ray.direction,
                    epsilon,
                    clamp01(interaction.transmission),
                    0.0,
                    format!("{}:T", surface.spec.id),
                ));
                next_id += 1;
            }
            "beam-splitter" => {
                let reflected = reflect(ray.direction, hit.normal_world);
                let reflectance = clamp01(interaction.reflectance);
                let physical = matches!(
                    interaction.beam_splitter_model.as_str(),
                    "plate" | "cube" | "pellicle"
                );
                let back_surface_transmission = if physical {
                    1.0 - clamp01(interaction.back_surface_reflectance)
                } else {
                    1.0
                };
                let transmittance = clamp01(interaction.transmittance) * back_surface_transmission;
                let normalization = (reflectance + transmittance).max(1.0);
                children.push(child_ray(
                    &ray,
                    next_id,
                    hit.point_world,
                    reflected,
                    epsilon,
                    reflectance / normalization,
                    interaction.reflected_phase_deg * PI / 180.0,
                    format!("{}:R", surface.spec.id),
                ));
                next_id += 1;

                let substrate_n = cauchy_index_from_nd_vd(
                    interaction.substrate_index_nd,
                    interaction.substrate_abbe_number,
                    ray.wavelength_nm,
                );
                let (shift, extra_opl_mm) = if physical {
                    beam_splitter_plate_equivalent(
                        ray.direction,
                        hit.normal_world,
                        interaction.substrate_thickness_mm,
                        substrate_n,
                    )
                } else {
                    (Vec3::default(), 0.0)
                };
                let wedge_axis = surface.world_vector(Vec3::new(1.0, 0.0, 0.0));
                let wedge_deviation = if physical {
                    (substrate_n - 1.0) * interaction.wedge_deg.to_radians()
                } else {
                    0.0
                };
                let transmitted_direction = ray
                    .direction
                    .add(wedge_axis.scale(wedge_deviation))
                    .normalized();
                let mut transmitted = child_ray(
                    &ray,
                    next_id,
                    hit.point_world.add(shift),
                    transmitted_direction,
                    epsilon,
                    transmittance / normalization,
                    interaction.transmitted_phase_deg * PI / 180.0,
                    format!(
                        "{}:T{}",
                        surface.spec.id,
                        if physical { "-substrate" } else { "" }
                    ),
                );
                transmitted.opl_mm += extra_opl_mm;
                children.push(transmitted);
                next_id += 1;
            }
            "thin-lens" => {
                let direction = apply_thin_lens(surface, &ray, &hit, interaction);
                children.push(child_ray(
                    &ray,
                    next_id,
                    hit.point_world,
                    direction,
                    epsilon,
                    clamp01(interaction.transmission),
                    0.0,
                    format!("{}:L", surface.spec.id),
                ));
                next_id += 1;
            }
            "grating" => {
                let orders = if interaction.allowed_orders.is_empty() {
                    vec![1]
                } else {
                    interaction.allowed_orders.clone()
                };
                let fallback_power = clamp01(interaction.efficiency)
                    * clamp01(interaction.substrate_reflectivity)
                    / orders.len().max(1) as f64;
                let mut propagating = Vec::new();
                for order in orders {
                    if let Some((direction, groove_phase)) = grating_direction(
                        surface,
                        &ray,
                        &hit,
                        order,
                        interaction.groove_density_lines_per_mm.max(0.0),
                        interaction.groove_direction,
                    ) {
                        let (power, efficiency_phase) = grating_complex_response(
                            interaction,
                            order,
                            ray.wavelength_nm,
                            fallback_power,
                        );
                        propagating.push((
                            order,
                            direction,
                            groove_phase + efficiency_phase,
                            power,
                        ));
                    }
                }
                let nondiffracted = clamp01(interaction.nondiffracted_reflectivity);
                let total_power =
                    propagating.iter().map(|entry| entry.3).sum::<f64>() + nondiffracted;
                let normalization = total_power.max(1.0);
                for (order, direction, phase, power) in propagating {
                    children.push(child_ray(
                        &ray,
                        next_id,
                        hit.point_world,
                        direction,
                        epsilon,
                        power / normalization,
                        phase,
                        format!("{}:m{}", surface.spec.id, order),
                    ));
                    next_id += 1;
                }
                if nondiffracted > 0.0 {
                    children.push(child_ray(
                        &ray,
                        next_id,
                        hit.point_world,
                        reflect(ray.direction, hit.normal_world),
                        epsilon,
                        nondiffracted / normalization,
                        PI,
                        format!("{}:specular", surface.spec.id),
                    ));
                    next_id += 1;
                }
            }
            "dielectric" => {
                let n1 = ray.medium_n.max(1e-12);
                let n2 = if (n1 - interaction.n_front).abs() < (n1 - interaction.n_back).abs() {
                    interaction.n_back
                } else {
                    interaction.n_front
                }
                .max(1e-12);
                let r = fresnel_unpolarized(ray.direction, hit.normal_world, n1, n2);
                let reflected = reflect(ray.direction, hit.normal_world);
                children.push(child_ray(
                    &ray,
                    next_id,
                    hit.point_world,
                    reflected,
                    epsilon,
                    r,
                    PI,
                    format!("{}:Fresnel-R", surface.spec.id),
                ));
                next_id += 1;
                if let Some(direction) = refract(ray.direction, hit.normal_world, n1, n2) {
                    let mut transmitted = child_ray(
                        &ray,
                        next_id,
                        hit.point_world,
                        direction,
                        epsilon,
                        1.0 - r,
                        0.0,
                        format!("{}:Fresnel-T", surface.spec.id),
                    );
                    transmitted.medium_n = n2;
                    children.push(transmitted);
                    next_id += 1;
                }
            }
            "absorber" => {
                energy.absorbed_power_w += power;
                terminated += 1;
            }
            _ => {
                children.push(child_ray(
                    &ray,
                    next_id,
                    hit.point_world,
                    ray.direction,
                    epsilon,
                    clamp01(interaction.transmission),
                    0.0,
                    format!("{}:T", surface.spec.id),
                ));
                next_id += 1;
            }
        }
        if interaction.kind != "detector" && interaction.kind != "absorber" {
            let outgoing_power: f64 = children.iter().map(|child| child.amplitude.norm2()).sum();
            energy.absorbed_power_w += (power - outgoing_power).max(0.0);
        }

        for child in children {
            let child_power = child.amplitude.norm2();
            if generated >= request.settings.max_generated_rays {
                energy.truncated_power_w += child_power;
                if warnings
                    .iter()
                    .all(|warning| !warning.contains("maximum generated ray count"))
                {
                    warnings.push("The maximum generated ray count was reached; low-priority branches were truncated.".to_string());
                }
            } else if child_power / emitted < request.settings.min_relative_power {
                energy.truncated_power_w += child_power;
            } else {
                queue.push_back(child);
                generated += 1;
            }
        }
    }
    let detectors = aggregate_detectors(&request.detectors, &contributions);
    let mut ghost_map: HashMap<String, (f64, usize)> = HashMap::new();
    for item in &contributions {
        let signature = if item.history.is_empty() {
            "primary".to_string()
        } else {
            item.history.clone()
        };
        let entry = ghost_map.entry(signature).or_insert((0.0, 0));
        entry.0 += item.ray_power_w;
        entry.1 += 1;
    }
    let mut ghost_paths: Vec<GhostPathResult> = ghost_map
        .into_iter()
        .map(
            |(signature, (detected_power_w, hit_count))| GhostPathResult {
                signature,
                detected_power_w,
                hit_count,
            },
        )
        .collect();
    ghost_paths.sort_by(|a, b| {
        b.detected_power_w
            .partial_cmp(&a.detected_power_w)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(TraceResult {
        segments,
        detectors,
        spectrum_lines,
        ghost_paths,
        energy,
        generated_ray_count: generated,
        terminated_ray_count: terminated,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(id: &str, z: f64, interaction: InteractionSpec) -> SurfaceSpec {
        SurfaceSpec {
            id: id.to_string(),
            component_id: id.to_string(),
            transform: TransformSpec {
                position_mm: Vec3::new(0.0, 0.0, z),
                rotation_deg: EulerDeg::default(),
            },
            geometry: GeometrySpec::default(),
            aperture: ApertureSpec {
                kind: "rectangle".to_string(),
                width_mm: 20.0,
                height_mm: 20.0,
                radius_mm: 0.0,
            },
            interaction,
        }
    }

    fn source() -> SourceSpec {
        SourceSpec {
            id: "source".to_string(),
            coherence_group_id: "source".to_string(),
            transform: TransformSpec {
                position_mm: Vec3::new(0.0, 0.0, -10.0),
                rotation_deg: EulerDeg::default(),
            },
            total_power_w: 1.0,
            beam_diameter_mm: 0.0,
            divergence_deg: 0.0,
            spatial_profile: "top-hat".to_string(),
            spatial_samples: 1,
            spectrum: SpectrumSpec {
                spectral_samples: 1,
                min_wavelength_nm: 500.0,
                max_wavelength_nm: 500.0,
                center_wavelength_nm: 500.0,
                ..SpectrumSpec::default()
            },
        }
    }

    #[test]
    fn comb_frequencies_follow_ceo_plus_n_frep() {
        let mut src = source();
        src.spectrum.kind = "frequency-comb".to_string();
        src.spectrum.repetition_rate_hz = 10e9;
        src.spectrum.ceo_frequency_hz = 2e9;
        src.spectrum.line_count = 5;
        let lines = generate_spectrum(&src);
        assert_eq!(lines.len(), 5);
        for pair in lines.windows(2) {
            assert!((pair[1].frequency_hz - pair[0].frequency_hz - 10e9).abs() < 1.0);
        }
        for line in lines {
            assert!((line.frequency_hz - (2e9 + line.line_index as f64 * 10e9)).abs() < 1.0);
        }
    }

    #[test]
    fn area_detector_receives_center_pixel() {
        let detector = DetectorSpec {
            id: "det".to_string(),
            pixel_count_x: 8,
            pixel_count_y: 8,
            pixel_pitch_um: 1000.0,
            ..DetectorSpec::default()
        };
        let surface = plane(
            "det-surface",
            0.0,
            InteractionSpec {
                kind: "detector".to_string(),
                detector_id: "det".to_string(),
                ..InteractionSpec::default()
            },
        );
        let result = trace_nonsequential(&TraceRequest {
            surfaces: vec![surface],
            sources: vec![source()],
            detectors: vec![detector],
            settings: TraceSettings::default(),
        })
        .unwrap();
        assert_eq!(result.detectors[0].hit_count, 1);
        assert!((result.detectors[0].integrated_power_w - 1.0).abs() < 1e-12);
        assert!(result.detectors[0].intensity_w_per_pixel[4 * 8 + 4] > 0.999999);
    }

    #[test]
    fn beam_splitter_plate_adds_substrate_opl_without_normal_incidence_shift() {
        let direction = Vec3::new(0.0, 0.0, 1.0);
        let normal = Vec3::new(0.0, 0.0, -1.0);
        let (shift, extra_opl_mm) = beam_splitter_plate_equivalent(direction, normal, 3.0, 1.5);
        assert!(shift.norm() < 1e-12);
        assert!((extra_opl_mm - 1.5).abs() < 1e-12);
    }

    #[test]
    fn beam_splitter_substrate_index_matches_nd_at_d_line() {
        let index = cauchy_index_from_nd_vd(1.5168, 64.17, 587.5618);
        assert!((index - 1.5168).abs() < 1e-12);
        let blue = cauchy_index_from_nd_vd(1.5168, 64.17, 486.1327);
        let red = cauchy_index_from_nd_vd(1.5168, 64.17, 656.2725);
        assert!(blue > red);
    }

    #[test]
    fn lossless_splitter_does_not_create_power() {
        let splitter = plane(
            "bs",
            0.0,
            InteractionSpec {
                kind: "beam-splitter".to_string(),
                reflectance: 0.5,
                transmittance: 0.5,
                ..InteractionSpec::default()
            },
        );
        let transmitted_detector = plane(
            "det-t",
            10.0,
            InteractionSpec {
                kind: "detector".to_string(),
                detector_id: "det-t".to_string(),
                ..InteractionSpec::default()
            },
        );
        let reflected_detector = SurfaceSpec {
            transform: TransformSpec {
                position_mm: Vec3::new(0.0, 0.0, -20.0),
                rotation_deg: EulerDeg {
                    x: 180.0,
                    y: 0.0,
                    z: 0.0,
                },
            },
            ..plane(
                "det-r",
                0.0,
                InteractionSpec {
                    kind: "detector".to_string(),
                    detector_id: "det-r".to_string(),
                    ..InteractionSpec::default()
                },
            )
        };
        let detectors = vec![
            DetectorSpec {
                id: "det-t".to_string(),
                ..DetectorSpec::default()
            },
            DetectorSpec {
                id: "det-r".to_string(),
                ..DetectorSpec::default()
            },
        ];
        let result = trace_nonsequential(&TraceRequest {
            surfaces: vec![splitter, transmitted_detector, reflected_detector],
            sources: vec![source()],
            detectors,
            settings: TraceSettings::default(),
        })
        .unwrap();
        assert!(
            (result.energy.detected_ray_power_w - 1.0).abs() < 1e-10,
            "{}",
            result.energy.detected_ray_power_w
        );
    }
    #[test]
    fn grating_vector_direction_and_complex_efficiency_are_physical() {
        let prepared = prepare_surface(plane("grating", 0.0, InteractionSpec::default()));
        let ray = RayState {
            id: 1,
            parent_id: None,
            source_id: "source".to_string(),
            coherence_group_id: "source".to_string(),
            line_index: 0,
            frequency_hz: C_M_PER_S / 600e-9,
            wavelength_nm: 600.0,
            position: Vec3::new(0.0, 0.0, -1.0),
            direction: Vec3::new(0.0, 0.0, 1.0),
            amplitude: Complex::from_power(1.0),
            medium_n: 1.0,
            opl_mm: 0.0,
            interactions: 0,
            history: Vec::new(),
        };
        let hit = Hit {
            surface_index: 0,
            t: 1.0,
            point_world: Vec3::default(),
            point_local: Vec3::default(),
            normal_world: Vec3::new(0.0, 0.0, 1.0),
            local_dir_z: 1.0,
        };
        let (dispersion_x, _) =
            grating_direction(&prepared, &ray, &hit, 1, 600.0, Vec3::new(0.0, 1.0, 0.0)).unwrap();
        let (dispersion_y, _) =
            grating_direction(&prepared, &ray, &hit, 1, 600.0, Vec3::new(1.0, 0.0, 0.0)).unwrap();
        assert!(dispersion_x.x > 0.35 && dispersion_x.y.abs() < 1e-12);
        assert!(dispersion_y.y < -0.35 && dispersion_y.x.abs() < 1e-12);

        let interaction = InteractionSpec {
            complex_efficiency: vec![
                ComplexEfficiencySpec {
                    wavelength_nm: 500.0,
                    order: 1,
                    amplitude: 0.5,
                    phase_deg: 0.0,
                },
                ComplexEfficiencySpec {
                    wavelength_nm: 700.0,
                    order: 1,
                    amplitude: 1.0,
                    phase_deg: 90.0,
                },
            ],
            ..InteractionSpec::default()
        };
        let (power, phase) = grating_complex_response(&interaction, 1, 600.0, 0.1);
        assert!((power - 0.5625).abs() < 1e-12);
        assert!((phase - PI / 4.0).abs() < 1e-12);
    }
    #[test]
    fn target_lambertian_scatter_conserves_reflected_power() {
        let interaction = InteractionSpec {
            kind: "target".to_string(),
            reflectivity: 0.7,
            scatter_model: "lambertian".to_string(),
            scatter_samples: 16,
            ..InteractionSpec::default()
        };
        let directions = target_scatter_directions(
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(0.0, 0.0, -1.0),
            &interaction,
        );
        assert_eq!(directions.len(), 16);
        assert!((directions.iter().map(|entry| entry.1).sum::<f64>() - 0.7).abs() < 1e-12);
        assert!(directions.iter().all(|entry| entry.0.z < 0.0));
    }

    #[test]
    fn target_tilt_and_sine_use_design_intent_height_units() {
        let base = TargetProfileSpec {
            span_mm: 50.0,
            offset_um: 3.0,
            amplitude_um: 20.0,
            period_mm: 10.0,
            ..TargetProfileSpec::default()
        };
        let tilt = TargetProfileSpec { kind: "tilt".to_string(), ..base.clone() };
        let (tilt_left_mm, tilt_slope) = target_height_and_slope(&tilt, -25.0);
        let (tilt_right_mm, _) = target_height_and_slope(&tilt, 25.0);
        assert!((tilt_left_mm + 0.017).abs() < 1e-12);
        assert!((tilt_right_mm - 0.023).abs() < 1e-12);
        assert!((tilt_slope - 0.0008).abs() < 1e-12);

        let sine = TargetProfileSpec { kind: "sine".to_string(), ..base };
        let (sine_high_mm, _) = target_height_and_slope(&sine, 2.5);
        let (sine_low_mm, _) = target_height_and_slope(&sine, 7.5);
        assert!((sine_high_mm - 0.023).abs() < 1e-12);
        assert!((sine_low_mm + 0.017).abs() < 1e-12);
    }
}

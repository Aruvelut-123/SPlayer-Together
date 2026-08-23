//! 跨平台统一的音频输出（纯 cpal，无 rodio）。
//!
//! cpal 0.18 起各后端的 `Stream` 均为 `Send`，可直接由 `PlaybackHandle` 持有，
//! 无需再为 `!Send` 做专用线程隔离。`AudioOutput` 只负责解析输出设备与配置：
//! 设备采样率即播放重采样目标，每次加载/seek 音源时按该配置创建独立输出流。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedStreamConfig};
use tracing::{debug, info, warn};

use crate::error::{AudioErrorKind, AudioResultExt};
use crate::source::DecoderSource;

/// 输出失败回调：实时错误线程调用，只允许发送轻量事件。
/// 禁止获取 `InnerPlayer` 锁、join 线程、枚举设备、创建新流或调用 NAPI async 方法。
pub type OutputFailureCallback = Arc<dyn Fn() + Send + Sync + 'static>;

/// 输出设备与配置句柄。`Send`，可放进 `InnerPlayer` 而不需 `unsafe impl Send`。
///
/// 不持有 `cpal::Stream`——输出流由每次加载音源时的 `PlaybackHandle::attach` 按此配置创建，
/// 因此切歌时无需跨线程移交流，也天然避免新旧流重叠占用设备。
pub struct AudioOutput {
    device: cpal::Device,
    config: SupportedStreamConfig,
    /// 该输出流的单调代次，用于诊断和过滤销毁后迟到的流错误
    generation: u64,
    on_failure: OutputFailureCallback,
}

impl AudioOutput {
    /// 解析输出设备与配置
    ///
    /// # Arguments
    /// * `device_name` - 输出设备名，`None` 走系统默认设备
    /// * `requested_sample_rate` - 期望输出采样率；设备支持时按此速率打开（音源精确采样率），
    ///   否则回退到设备默认配置。`None` 表示直接用设备默认配置
    /// * `generation` - 输出流单调代次，见 [`AudioOutput`] 字段说明
    /// * `on_failure` - 运行期流错误回调，见 [`OutputFailureCallback`]
    ///
    /// # Errors
    /// - 找不到指定设备
    /// - 无可用音频设备
    pub fn new(
        device_name: Option<&str>,
        requested_sample_rate: Option<u32>,
        generation: u64,
        on_failure: OutputFailureCallback,
    ) -> Result<Self> {
        let (device, config) = open_device(device_name, requested_sample_rate)
            .with_audio_kind(AudioErrorKind::Device)?;
        info!(
            device = %device,
            sample_rate = config.sample_rate(),
            "打开音频输出配置"
        );
        Ok(Self {
            device,
            config,
            generation,
            on_failure,
        })
    }

    /// 实际输出流采样率（播放重采样目标）
    pub fn sample_rate(&self) -> u32 {
        self.config.sample_rate()
    }

    /// 实际输出流声道数
    pub fn channels(&self) -> u16 {
        self.config.channels()
    }

    /// 按本配置创建一次播放的输出流，实时回调从 `source` 拉取样本。
    /// 调用方持有返回的 `Stream`，直到本次播放结束。
    pub(crate) fn build_stream(
        &self,
        source: DecoderSource,
        volume: Arc<AtomicU32>,
        stopped: Arc<AtomicBool>,
    ) -> Result<cpal::Stream> {
        let device = self.device.clone();
        let config = self.config.clone();
        let on_failure = Arc::clone(&self.on_failure);
        run_in_clean_mta(move || {
            build_typed_stream_for_format(
                &device,
                &config,
                source,
                volume,
                stopped,
                on_failure,
            )
        })
        .with_audio_kind(AudioErrorKind::Device)
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        debug!(generation = self.generation, "释放音频输出配置");
    }
}

/// 在干净的 COM MTA 线程环境中运行任务（Windows 特需，防止 Node.js STA 或线程池残留的 COM 冲突）
#[cfg(target_os = "windows")]
fn run_in_clean_mta<T: Send + 'static, F: FnOnce() -> Result<T> + Send + 'static>(f: F) -> Result<T> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
    std::thread::Builder::new()
        .name("audio-mta-worker".into())
        .spawn(move || {
            let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let result = f();
            unsafe { CoUninitialize() };
            result
        })
        .map_err(|e| anyhow!("启动 MTA 线程失败: {e}"))?
        .join()
        .map_err(|_| anyhow!("MTA 线程发生 panic"))?
}

#[cfg(not(target_os = "windows"))]
fn run_in_clean_mta<T, F: FnOnce() -> Result<T>>(f: F) -> Result<T> {
    f()
}

/// 设备持久化选择键：cpal 0.18 起 `Device::name()` 并入 `description().name()`，
/// 沿用该值以避免升级后已有配置失效
fn persisted_device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|desc| desc.name().to_owned())
}

/// 枚举所有输出设备，返回 `(name, is_default)` 列表
/// 纯查询，不涉及流状态，调用方任意线程都能用
pub fn list_output_devices() -> Vec<(String, bool)> {
    run_in_clean_mta(|| {
        let host = cpal::default_host();
        let default_name = host
            .default_output_device()
            .and_then(|device| persisted_device_name(&device));
        let list = host
            .output_devices()
            .map(|devices| {
                devices
                    .filter_map(|device| {
                        let name = persisted_device_name(&device)?;
                        let is_default = default_name.as_deref() == Some(name.as_str());
                        Some((name, is_default))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(list)
    })
    .unwrap_or_default()
}

/// 取系统默认输出设备名
pub fn default_device_name() -> Option<String> {
    run_in_clean_mta(|| {
        let name = cpal::default_host()
            .default_output_device()
            .and_then(|device| persisted_device_name(&device));
        Ok(name)
    })
    .unwrap_or_default()
}

/// 按设备名（`None` 为默认设备）解析设备与输出配置。
/// 设备支持 `requested_sample_rate` 时按该速率打开，否则使用设备默认配置。
/// 样本格式优先沿用设备默认格式：PipeWire 等后端上报的 supported 列表包含
/// 全部合成格式（顺序 I8…F64），首个条目不代表设备真实能力，直接采用会导致
/// 以 i8 打开输出流而严重劣化音质。
fn open_device_internal(
    device_name: Option<&str>,
    requested_sample_rate: Option<u32>,
) -> Result<(cpal::Device, SupportedStreamConfig)> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) => host
            .output_devices()
            .context("枚举输出设备失败")?
            .find(|device| persisted_device_name(device).as_deref() == Some(name))
            .with_context(|| format!("输出设备 '{name}' 不存在"))?,
        None => host.default_output_device().context("没有可用的输出设备")?,
    };
    let config = match requested_sample_rate {
        Some(rate) => {
            let default_config = device.default_output_config();
            let default_format = default_config
                .as_ref()
                .ok()
                .map(|config| config.sample_format());
            let default_channels = default_config.as_ref().ok().map(|config| config.channels());
            let at_rate = device.supported_output_configs().ok().and_then(|configs| {
                let configs: Vec<_> = configs.collect();
                configs
                    .iter()
                    .copied()
                    .find(|range| {
                        range.min_sample_rate() <= rate
                            && rate <= range.max_sample_rate()
                            && Some(range.sample_format()) == default_format
                            && Some(range.channels()) == default_channels
                    })
                    .or_else(|| {
                        configs.iter().copied().find(|range| {
                            range.min_sample_rate() <= rate
                                && rate <= range.max_sample_rate()
                                && Some(range.sample_format()) == default_format
                        })
                    })
                    .or_else(|| {
                        configs.iter().copied().find(|range| {
                            range.min_sample_rate() <= rate
                                && rate <= range.max_sample_rate()
                                && Some(range.channels()) == default_channels
                        })
                    })
                    .or_else(|| {
                        configs.iter().copied().find(|range| {
                            range.min_sample_rate() <= rate && rate <= range.max_sample_rate()
                        })
                    })
                    .map(|range| range.with_sample_rate(rate))
            });
            match at_rate {
                Some(config) => config,
                None => default_config.context("读取输出设备配置失败")?,
            }
        }
        None => device
            .default_output_config()
            .context("读取输出设备配置失败")?,
    };
    Ok((device, config))
}

fn open_device(
    device_name: Option<&str>,
    requested_sample_rate: Option<u32>,
) -> Result<(cpal::Device, SupportedStreamConfig)> {
    let name_owned = device_name.map(String::from);
    run_in_clean_mta(move || {
        open_device_internal(name_owned.as_deref(), requested_sample_rate)
    })
}

/// 按样本格式分发到类型化构建
fn build_typed_stream_for_format(
    device: &cpal::Device,
    config: &SupportedStreamConfig,
    source: DecoderSource,
    volume: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
    on_failure: OutputFailureCallback,
) -> Result<cpal::Stream> {
    let sample_format = config.sample_format();
    let config: StreamConfig = config.config();
    macro_rules! build {
        ($sample:ty) => {
            build_typed_stream::<$sample>(device, config, source, volume, stopped, on_failure)
        };
    }
    match sample_format {
        SampleFormat::I8 => build!(i8),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I24 => build!(cpal::I24),
        SampleFormat::I32 => build!(i32),
        SampleFormat::I64 => build!(i64),
        SampleFormat::U8 => build!(u8),
        SampleFormat::U16 => build!(u16),
        SampleFormat::U32 => build!(u32),
        SampleFormat::U64 => build!(u64),
        SampleFormat::F32 => build!(f32),
        SampleFormat::F64 => build!(f64),
        _ => Err(anyhow!("不支持的输出样本格式: {sample_format}")),
    }
}

fn build_typed_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    mut source: DecoderSource,
    volume: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
    on_failure: OutputFailureCallback,
) -> Result<cpal::Stream>
where
    T: SizedSample + Sample + FromSample<f32>,
{
    let stream = device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            let gain = f32::from_bits(volume.load(Ordering::Relaxed));
            if stopped.load(Ordering::Acquire) {
                data.fill(T::EQUILIBRIUM);
                return;
            }
            for output in data {
                *output = T::from_sample(source.next().unwrap_or(0.0) * gain);
            }
        },
        move |error| {
            warn!(%error, "音频输出流失败");
            on_failure();
        },
        None,
    )?;
    Ok(stream)
}

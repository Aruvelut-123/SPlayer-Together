//! 跨线程安全的音频输出
//!
//! `cpal::Stream`（以及包装它的 `rodio::MixerDeviceSink`）是 `!Send` 的——
//! cpal 文档明确要求 Stream 的创建、持有和 drop 都在同一线程上完成
//! （macOS CoreAudio 是真雷区，Windows WASAPI / Linux ALSA 是契约要求）。
//!
//! 但 NAPI 的 async fn 跑在多线程 tokio runtime 上，`.await` 后 Future
//! 可能在任意 worker thread 恢复，原本通过 `unsafe impl Send` 绕过类型系统的
//! 做法在 macOS 上是真 UB，其它平台属于"现在凑合能跑"的契约违反。
//!
//! 本模块的做法：开一个专用 `audio-output-owner` 线程独占持有 `MixerDeviceSink`，
//! 对外只暴露可跨线程克隆的 `Mixer`。
//! Stream 在该线程上创建，在该线程上 drop，永远不会被跨线程访问。

use std::sync::mpsc;
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use rodio::cpal::{self, traits::DeviceTrait, traits::HostTrait};
use rodio::{mixer::Mixer, DeviceSinkBuilder, MixerDeviceSink};
use tracing::{debug, info, warn};

use crate::error::{AudioErrorKind, AudioResultExt};
use crate::priority;

/// 输出失败回调：实时错误线程调用，只允许发送轻量事件。
/// 禁止获取 `InnerPlayer` 锁、join 线程、枚举设备、创建新流或调用 NAPI async 方法。
pub type OutputFailureCallback = std::sync::Arc<dyn Fn() + Send + Sync + 'static>;

/// 持有音频输出的跨线程句柄。`Send`，可放进 `InnerPlayer` 而不需 `unsafe impl Send`。
///
/// 内部专用线程独占 `MixerDeviceSink`，drop 这个结构会通过 channel 通知线程退出，
/// 线程退出时 drop `MixerDeviceSink`——确保 `cpal::Stream` 创建和销毁都在同一线程。
///
/// # Examples
///
/// ```ignore
/// // 走系统默认设备
/// let output = AudioOutput::new(None)?;
/// let player = Player::connect_new(output.mixer());
/// // player 可在任意线程上使用；output 持有的 cpal::Stream 始终在专用线程上
/// ```
pub struct AudioOutput {
    mixer: Mixer,
    /// 该输出流的单调代次，用于诊断和过滤销毁后迟到的流错误
    generation: u64,
    /// 实际打开的输出流采样率
    sample_rate: u32,
    /// drop 这个 sender 会让 owner 线程的 recv 返回 Err，从而退出并释放 Stream
    /// 包成 Option 是为了 Drop 里能 take() 出来显式 drop，从而在 join 前先关闭 channel
    shutdown: Option<mpsc::Sender<()>>,
    /// owner 线程句柄，Drop 时 join 等待 cpal stream 在该线程真正释放
    thread: Option<JoinHandle<()>>,
}

impl AudioOutput {
    /// 在专用线程上创建音频输出
    ///
    /// # Arguments
    /// * `device_name` - 输出设备名，`None` 走系统默认设备
    /// * `requested_sample_rate` - 期望输出采样率；设备支持时按此打开流（音源精确采样率），
    ///   否则回退到设备默认配置。`None` 表示直接用设备默认配置
    /// * `on_failure` - 运行期流错误回调，见 [`OutputFailureCallback`]
    ///
    /// # Errors
    /// - 找不到指定设备
    /// - 无可用音频设备
    /// - 专用线程 spawn 失败
    pub fn new(
        device_name: Option<&str>,
        requested_sample_rate: Option<u32>,
        generation: u64,
        on_failure: OutputFailureCallback,
    ) -> Result<Self> {
        let device_name = device_name.map(String::from);

        // 把构建结果回传给调用线程；用 sync_channel 容量 1 避免发送方阻塞
        let (result_tx, result_rx) = mpsc::sync_channel::<Result<(Mixer, u32)>>(1);
        // 调用方 drop AudioOutput 时关闭，触发 owner 线程退出
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        let thread = thread::Builder::new()
            .name("audio-output-owner".to_string())
            .spawn(move || {
                priority::boost_current_audio_thread("audio-output-owner");
                debug!(device = ?device_name, "audio-output-owner: starting");
                let build_result =
                    build_output_sink(device_name.as_deref(), requested_sample_rate, on_failure);
                match build_result {
                    Ok((mut sink, sample_rate)) => {
                        sink.log_on_drop(false);
                        if result_tx
                            .send(Ok((sink.mixer().clone(), sample_rate)))
                            .is_err()
                        {
                            // 调用方已放弃接收：在本线程 drop sink 后退出
                            warn!("audio-output-owner: receiver dropped before handshake");
                            drop(sink);
                            return;
                        }
                        // 持有 sink，等待 shutdown 信号或 channel 关闭
                        let _ = shutdown_rx.recv();
                        debug!("audio-output-owner: shutting down, dropping cpal stream");
                        drop(sink);
                    }
                    Err(err) => {
                        warn!(error = %err, "audio-output-owner: build_output_sink failed");
                        let _ = result_tx.send(Err(err));
                    }
                }
            })
            .context("failed to spawn audio-output-owner thread")
            .with_audio_kind(AudioErrorKind::Device)?;

        let (mixer, sample_rate) = result_rx
            .recv()
            .context("audio output owner thread terminated unexpectedly")
            .with_audio_kind(AudioErrorKind::Device)??;

        Ok(Self {
            mixer,
            generation,
            sample_rate,
            shutdown: Some(shutdown_tx),
            thread: Some(thread),
        })
    }

    /// 借出输出混音器，用于连接 `Player`
    pub fn mixer(&self) -> &Mixer {
        &self.mixer
    }

    /// 输出流采样率，作为播放重采样目标
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

}

impl Drop for AudioOutput {
    /// 确定性释放：先 drop 发送端通知 owner 线程退出，再 join 等待 cpal stream 真正释放
    ///
    /// 这样 `set_output_device` 等场景里新旧 stream 不会重叠占用设备，
    /// 在 macOS / Linux 上避免 "device busy" 风险
    fn drop(&mut self) {
        debug!(generation = self.generation, "释放音频输出");
        // 先 drop sender 让 owner 线程的 shutdown_rx.recv() 返回 Err 退出
        drop(self.shutdown.take());
        if let Some(thread) = self.thread.take() {
            // 忽略 join 错误：owner 线程已经在 stream drop 时尽力清理过了
            let _ = thread.join();
        }
    }
}

/// 构建 cpal/rodio 输出流；**仅在 `audio-output-owner` 线程内调用**，
/// 保证 `MixerDeviceSink` 的创建、持有和 drop 都发生在同一线程上
///
/// `requested_sample_rate` 为期望采样率：设备支持时按精确采样率打开（音源原始采样率），
/// 否则使用设备默认配置，返回实际采样率供播放重采样器与 DSP 使用。
fn build_output_sink(
    device_name: Option<&str>,
    requested_sample_rate: Option<u32>,
    on_failure: OutputFailureCallback,
) -> Result<(MixerDeviceSink, u32)> {
    let host = cpal::default_host();
    match device_name {
        Some(name) => {
            let device = host
                .output_devices()
                .context("Failed to enumerate output devices")?
                .find(|device| persisted_device_name(device).as_deref() == Some(name))
                .with_context(|| format!("Output device '{}' not found", name))
                .with_audio_kind(AudioErrorKind::Device)?;
            open_device_with_error_callback(&device, requested_sample_rate, &on_failure)
        }
        None => open_default_sink_with_callback(requested_sample_rate, &on_failure),
    }
}

/// 从一次流错误回调参数构造失败事件闭包
///
/// 闭包捕获的都是可克隆值（`Arc`），满足 rodio builder 的 `E: Clone` 约束，
/// 同一份回调可安全复用到多次候选设备尝试。
fn error_callback(
    on_failure: &OutputFailureCallback,
) -> impl FnMut(cpal::StreamError) + Clone + Send + 'static {
    let on_failure = std::sync::Arc::clone(on_failure);
    move |_error| {
        on_failure();
    }
}

/// 设备名已被设置持久化为选择键，继续沿用旧 API 的值以避免升级后已有配置失效
#[allow(deprecated)]
fn persisted_device_name(device: &cpal::Device) -> Option<String> {
    device.name().ok()
}

/// 设备是否支持目标采样率（任一支持的配置范围覆盖该速率即可）
fn rate_supported(device: &cpal::Device, rate: u32) -> bool {
    device
        .supported_output_configs()
        .ok()
        .into_iter()
        .flatten()
        .any(|range| range.min_sample_rate() <= rate && rate <= range.max_sample_rate())
}

/// 使用设备默认配置创建输出流，并注册运行期流错误回调；
/// 目标采样率被设备支持时按该速率打开，否则保持默认配置
fn open_device_with_error_callback(
    device: &cpal::Device,
    requested_sample_rate: Option<u32>,
    on_failure: &OutputFailureCallback,
) -> Result<(MixerDeviceSink, u32)> {
    let mut builder = DeviceSinkBuilder::from_device(device.clone())
        .context("Failed to get default output config")?
        .with_error_callback(error_callback(on_failure));
    if let Some(rate) = requested_sample_rate.filter(|rate| rate_supported(device, *rate)) {
        builder = builder.with_sample_rate(rodio::SampleRate::new(rate).unwrap());
    }
    let sink = builder
        .open_sink_or_fallback()
        .context("Failed to open output device")
        .with_audio_kind(AudioErrorKind::Device)?;
    let sample_rate = sink.config().sample_rate().get();
    info!(sample_rate, "打开音频输出");
    Ok((sink, sample_rate))
}

/// 打开系统默认输出设备并注册错误回调；默认设备失败时枚举其它非 null 输出设备兜底
///
/// rodio 的静态 `open_default_sink` 无法注入自定义错误回调，此处复刻其兜底逻辑：
/// 每次候选尝试都使用同一份错误回调，全部失败时返回第一次默认设备的错误并标记为设备错误。
fn open_default_sink_with_callback(
    requested_sample_rate: Option<u32>,
    on_failure: &OutputFailureCallback,
) -> Result<(MixerDeviceSink, u32)> {
    let host = cpal::default_host();
    let default_device = host.default_output_device().ok_or(rodio::DeviceSinkError::NoDevice);
    let open = |device: cpal::Device| {
        let wants_rate = requested_sample_rate.filter(|rate| rate_supported(&device, *rate));
        let mut builder = DeviceSinkBuilder::from_device(device)?
            .with_error_callback(error_callback(on_failure));
        if let Some(rate) = wants_rate {
            builder = builder.with_sample_rate(rodio::SampleRate::new(rate).unwrap());
        }
        builder.open_stream()
    };

    let sink = match default_device.and_then(open) {
        Ok(sink) => sink,
        Err(original) => {
            let devices = host
                .output_devices()
                .context("Failed to enumerate output devices")
                .with_audio_kind(AudioErrorKind::Device)?;
            devices
                .filter(|device| {
                    device
                        .description()
                        .map(|desc| desc.driver().is_some_and(|driver| driver != "null"))
                        .unwrap_or(false)
                })
                .find_map(|device| open(device).ok())
                .ok_or(original)
                .map_err(anyhow::Error::from)
                .with_audio_kind(AudioErrorKind::Device)?
        }
    };
    let sample_rate = sink.config().sample_rate().get();
    info!(sample_rate, "使用系统默认音频输出配置");
    Ok((sink, sample_rate))
}

/// 枚举所有输出设备，返回 `(name, is_default)` 列表
/// 纯查询，不涉及 `!Send` 状态，调用方任意线程都能用
pub fn list_output_devices() -> Vec<(String, bool)> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| persisted_device_name(&device));
    host.output_devices()
        .map(|devices| {
            devices
                .filter_map(|device| {
                    let name = persisted_device_name(&device)?;
                    let is_default = default_name.as_ref() == Some(&name);
                    Some((name, is_default))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 取系统默认输出设备名
pub fn default_device_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|device| persisted_device_name(&device))
}

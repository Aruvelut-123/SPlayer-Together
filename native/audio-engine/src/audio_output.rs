//! 跨线程安全的音频输出
//!
//! `cpal::Stream`（以及包装它的 `rodio::OutputStream`）是 `!Send` 的——
//! cpal 文档明确要求 Stream 的创建、持有和 drop 都在同一线程上完成
//! （macOS CoreAudio 是真雷区，Windows WASAPI / Linux ALSA 是契约要求）。
//!
//! 但 NAPI 的 async fn 跑在多线程 tokio runtime 上，`.await` 后 Future
//! 可能在任意 worker thread 恢复，原本通过 `unsafe impl Send` 绕过类型系统的
//! 做法在 macOS 上是真 UB，其它平台属于"现在凑合能跑"的契约违反。
//!
//! 本模块的做法：开一个专用 `audio-output-owner` 线程独占持有 `OutputStream`，
//! 对外只暴露 `Send` 的 `OutputStreamHandle`（rodio 文档承诺该类型跨线程安全）。
//! Stream 在该线程上创建，在该线程上 drop，永远不会被跨线程访问。

use std::sync::mpsc;
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use rodio::{OutputStream, OutputStreamHandle};
use tracing::{debug, warn};

use crate::priority;

/// 持有音频输出的跨线程句柄。`Send`，可放进 `InnerPlayer` 而不需 `unsafe impl Send`。
///
/// 内部专用线程独占 `OutputStream`，drop 这个结构会通过 channel 通知线程退出，
/// 线程退出时 drop `OutputStream`——确保 `cpal::Stream` 创建和销毁都在同一线程。
///
/// # Examples
///
/// ```ignore
/// // 走系统默认设备
/// let output = AudioOutput::new(None)?;
/// let sink = Sink::try_new(output.handle())?;
/// // sink 可在任意线程上使用；output 持有的 cpal::Stream 始终在专用线程上
/// ```
pub struct AudioOutput {
    handle: OutputStreamHandle,
    /// 输出流采样率（设备支持的最高，封顶 192000）
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
    ///
    /// # Errors
    /// - 找不到指定设备
    /// - 无可用音频设备
    /// - 专用线程 spawn 失败
    pub fn new(device_name: Option<&str>) -> Result<Self> {
        priority::configure_process_priority();
        let device_name = device_name.map(String::from);

        // 把构建结果回传给调用线程；用 sync_channel 容量 1 避免发送方阻塞
        let (result_tx, result_rx) = mpsc::sync_channel::<Result<(OutputStreamHandle, u32)>>(1);
        // 调用方 drop AudioOutput 时关闭，触发 owner 线程退出
        let (shutdown_tx, shutdown_rx) = mpsc::channel::<()>();

        let thread = thread::Builder::new()
            .name("audio-output-owner".to_string())
            .spawn(move || {
                priority::boost_current_audio_thread("audio-output-owner");
                debug!(device = ?device_name, "audio-output-owner: starting");
                let build_result = build_output_stream(device_name.as_deref());
                match build_result {
                    Ok((stream, handle, sample_rate)) => {
                        if result_tx.send(Ok((handle, sample_rate))).is_err() {
                            // 调用方已放弃接收：在本线程 drop stream 后退出
                            warn!("audio-output-owner: receiver dropped before handshake");
                            drop(stream);
                            return;
                        }
                        // 持有 stream，等待 shutdown 信号或 channel 关闭
                        let _ = shutdown_rx.recv();
                        debug!("audio-output-owner: shutting down, dropping cpal stream");
                        drop(stream);
                    }
                    Err(err) => {
                        warn!(error = %err, "audio-output-owner: build_output_stream failed");
                        let _ = result_tx.send(Err(err));
                    }
                }
            })
            .context("failed to spawn audio-output-owner thread")?;

        let (handle, sample_rate) = result_rx
            .recv()
            .context("audio output owner thread terminated unexpectedly")??;

        Ok(Self {
            handle,
            sample_rate,
            shutdown: Some(shutdown_tx),
            thread: Some(thread),
        })
    }

    /// 借出 `OutputStreamHandle`，用于创建 `Sink` 等
    pub fn handle(&self) -> &OutputStreamHandle {
        &self.handle
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
        // 先 drop sender 让 owner 线程的 shutdown_rx.recv() 返回 Err 退出
        drop(self.shutdown.take());
        if let Some(thread) = self.thread.take() {
            // 忽略 join 错误：owner 线程已经在 stream drop 时尽力清理过了
            let _ = thread.join();
        }
    }
}

/// 采样率上限：避免设备报告极高值（如 384000）导致无谓的 CPU/内存开销
const SAMPLE_RATE_CAP: u32 = 192_000;

/// 构建 cpal/rodio 输出流；**仅在 `audio-output-owner` 线程内调用**，
/// 保证 `OutputStream` 的创建、持有和 drop 都发生在同一线程上
///
/// 返回的采样率为设备支持的最高采样率（封顶 192000），用作播放重采样目标。
/// 避免 pipewire 等默认 44100 导致高采样率音频被降采样
fn build_output_stream(
    device_name: Option<&str>,
) -> Result<(OutputStream, OutputStreamHandle, u32)> {
    let host = cpal::default_host();
    match device_name {
        Some(name) => {
            let device = host
                .output_devices()
                .context("Failed to enumerate output devices")?
                .find(|d| d.name().map(|got| got == name).unwrap_or(false))
                .with_context(|| format!("Output device '{}' not found", name))?;
            open_device_with_best_rate(&device)
        }
        None => open_default_stream(&host),
    }
}

fn open_default_stream(host: &cpal::Host) -> Result<(OutputStream, OutputStreamHandle, u32)> {
    let default_device = host
        .default_output_device()
        .context("No default output device")?;
    if let Ok(result) = open_device_with_best_rate(&default_device) {
        return Ok(result);
    }

    // 默认设备打不开：遍历其它设备，打开成功的那个用它自身的采样率
    let devices = host
        .output_devices()
        .context("Failed to enumerate output devices")?;
    for device in devices {
        if let Ok(result) = open_device_with_best_rate(&device) {
            return Ok(result);
        }
    }
    anyhow::bail!("No usable output device")
}

/// 用设备支持的最高采样率创建输出流
fn open_device_with_best_rate(
    device: &cpal::Device,
) -> Result<(OutputStream, OutputStreamHandle, u32)> {
    let config = pick_best_config(device)?;
    let sample_rate = config.sample_rate().0;
    let (stream, handle) = OutputStream::try_from_device_config(device, config)
        .context("Failed to open output device")?;
    Ok((stream, handle, sample_rate))
}

/// 在设备支持的采样率范围内选取最高的，避免 pipewire 等默认 44100 导致高采样率音频被降采样
///
/// 从 `supported_output_configs` 中找与默认配置（声道/格式）匹配且 max_sample_rate 最高的范围，
/// 用 `with_sample_rate` 构造具体配置。封顶 192000 避免极高值导致无谓开销。
/// 查询失败或无更高速率时回退到默认配置
fn pick_best_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig> {
    let default_config = device
        .default_output_config()
        .context("Failed to get default output config")?;
    let default_rate = default_config.sample_rate().0;

    let target_channels = default_config.channels();
    let target_format = default_config.sample_format();

    let ranges: Vec<_> = device
        .supported_output_configs()
        .context("Failed to enumerate supported output configs")?
        .collect();

    // 在匹配声道/格式的范围中找 max_sample_rate 最高的，用其上限（封顶）创建配置
    let best = ranges
        .into_iter()
        .filter(|range| {
            range.channels() == target_channels && range.sample_format() == target_format
        })
        .max_by_key(|range| range.max_sample_rate().0)
        .filter(|range| range.max_sample_rate().0 > default_rate)
        .map(|range| {
            let rate = range.max_sample_rate().0.min(SAMPLE_RATE_CAP);
            range.with_sample_rate(cpal::SampleRate(rate))
        });

    match best {
        Some(config) => Ok(config),
        None => Ok(default_config),
    }
}

/// 枚举所有输出设备，返回 `(name, is_default)` 列表
/// 纯查询，不涉及 `!Send` 状态，调用方任意线程都能用
pub fn list_output_devices() -> Vec<(String, bool)> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    host.output_devices()
        .map(|devices| {
            devices
                .filter_map(|device| {
                    let name = device.name().ok()?;
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
        .and_then(|d| d.name().ok())
}

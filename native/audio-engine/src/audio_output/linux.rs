use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedStreamConfig};
use tracing::{debug, info, warn};

use super::{AudioOutput, OutputFailureCallback};
use crate::error::{AudioErrorKind, AudioResultExt};
use crate::source::DecoderSource;

pub struct LinuxPlayback {
    stream: cpal::Stream,
    volume: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
}

impl LinuxPlayback {
    pub fn new(
        output: &AudioOutput,
        source: DecoderSource,
        volume: f32,
        paused: bool,
    ) -> Result<Self> {
        let (device, config) = open_device(output.device_name.as_deref(), None)
            .with_audio_kind(AudioErrorKind::Device)?;
        if config.sample_rate() != output.sample_rate {
            return Err(anyhow!("输出设备配置在创建播放流前发生变化"));
        }

        let volume = Arc::new(AtomicU32::new(volume.to_bits()));
        let stopped = Arc::new(AtomicBool::new(false));
        let stream = build_stream(
            &device,
            config,
            source,
            Arc::clone(&volume),
            Arc::clone(&stopped),
            Arc::clone(&output.on_failure),
        )
        .with_audio_kind(AudioErrorKind::Device)?;
        stream
            .play()
            .context("启动 Linux 音频输出失败")
            .with_audio_kind(AudioErrorKind::Device)?;
        if paused {
            stream
                .pause()
                .context("暂停 Linux 音频输出失败")
                .with_audio_kind(AudioErrorKind::Device)?;
        }
        Ok(Self {
            stream,
            volume,
            stopped,
        })
    }

    pub fn play(&self) {
        if let Err(error) = self.stream.play() {
            warn!(%error, "恢复 Linux 音频输出失败");
        }
    }

    pub fn pause(&self) {
        if let Err(error) = self.stream.pause() {
            warn!(%error, "暂停 Linux 音频输出失败");
        }
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
    }

    pub fn set_volume(&self, volume: f32) {
        self.volume.store(volume.to_bits(), Ordering::Relaxed);
    }
}

impl AudioOutput {
    pub fn new(
        device_name: Option<&str>,
        requested_sample_rate: Option<u32>,
        generation: u64,
        on_failure: OutputFailureCallback,
    ) -> Result<Self> {
        let (device, config) =
            open_device(device_name, requested_sample_rate).with_audio_kind(AudioErrorKind::Device)?;
        info!(
            device = %device,
            sample_rate = config.sample_rate(),
            "打开 Linux 原生音频输出配置"
        );
        Ok(Self {
            device_name: device_name.map(str::to_owned),
            generation,
            sample_rate: config.sample_rate(),
            on_failure,
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn build_playback(
        &self,
        source: DecoderSource,
        volume: f32,
        paused: bool,
    ) -> Result<LinuxPlayback> {
        LinuxPlayback::new(self, source, volume, paused)
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        debug!(generation = self.generation, "释放 Linux 音频输出配置");
    }
}

pub fn list_output_devices() -> Vec<(String, bool)> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .map(|device| device.to_string());
    host.output_devices()
        .map(|devices| {
            devices
                .map(|device| {
                    let name = device.to_string();
                    let is_default = default_name.as_ref() == Some(&name);
                    (name, is_default)
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn default_device_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .map(|device| device.to_string())
}

fn open_device(
    device_name: Option<&str>,
    requested_sample_rate: Option<u32>,
) -> Result<(cpal::Device, SupportedStreamConfig)> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(name) => host
            .output_devices()
            .context("枚举 Linux 输出设备失败")?
            .find(|device| device.to_string() == name)
            .with_context(|| format!("输出设备 '{name}' 不存在"))?,
        None => host
            .default_output_device()
            .context("没有可用的 Linux 输出设备")?,
    };
    let config = requested_sample_rate
        .and_then(|rate| {
            device
                .supported_output_configs()
                .ok()?
                .find(|range| range.min_sample_rate() <= rate && rate <= range.max_sample_rate())
                .map(|range| range.with_sample_rate(rate))
        })
        .unwrap_or(
            device
                .default_output_config()
                .context("读取 Linux 输出设备配置失败")?,
        );
    Ok((device, config))
}

fn build_stream(
    device: &cpal::Device,
    config: SupportedStreamConfig,
    source: DecoderSource,
    volume: Arc<AtomicU32>,
    stopped: Arc<AtomicBool>,
    on_failure: OutputFailureCallback,
) -> Result<cpal::Stream> {
    let sample_format = config.sample_format();
    let config: StreamConfig = config.into();
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
        _ => Err(anyhow!("不支持的 Linux 输出样本格式: {sample_format}")),
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
            warn!(%error, "Linux 原生音频输出流失败");
            on_failure();
        },
        None,
    )?;
    Ok(stream)
}

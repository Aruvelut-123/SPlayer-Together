#[cfg(not(target_os = "linux"))]
use rodio::Player as RodioPlayer;

use crate::audio_output::AudioOutput;
use crate::source::DecoderSource;

/// 平台输出的播放控制句柄。
/// Linux 使用 CPAL 原生后端；其它平台维持 Rodio 输出。
pub struct PlaybackHandle {
    #[cfg(target_os = "linux")]
    inner: crate::audio_output::LinuxPlayback,
    #[cfg(not(target_os = "linux"))]
    inner: RodioPlayer,
}

impl PlaybackHandle {
    #[cfg(not(target_os = "linux"))]
    pub fn attach(
        output: &AudioOutput,
        source: DecoderSource,
        volume: f32,
        paused: bool,
    ) -> anyhow::Result<Self> {
        let inner = RodioPlayer::connect_new(output.mixer());
        inner.set_volume(volume);
        if paused {
            inner.pause();
        }
        inner.append(source);
        Ok(Self { inner })
    }

    #[cfg(target_os = "linux")]
    pub fn attach(
        output: &AudioOutput,
        source: DecoderSource,
        volume: f32,
        paused: bool,
    ) -> anyhow::Result<Self> {
        Ok(Self {
            inner: output.build_playback(source, volume, paused)?,
        })
    }

    pub fn play(&self) {
        self.inner.play();
    }

    pub fn pause(&self) {
        self.inner.pause();
    }

    pub fn stop(&self) {
        self.inner.stop();
    }

    pub fn set_volume(&self, volume: f32) {
        self.inner.set_volume(volume);
    }

    pub fn is_empty(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            true
        }
        #[cfg(not(target_os = "linux"))]
        self.inner.empty()
    }
}

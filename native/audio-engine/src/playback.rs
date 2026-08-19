use rodio::Player as RodioPlayer;

use crate::audio_output::AudioOutput;
use crate::source::DecoderSource;

/// 平台输出的播放控制句柄。
/// 当前由 Rodio 实现；Linux CPAL 后端接入时仅替换本模块的实现。
pub struct PlaybackHandle {
    inner: RodioPlayer,
}

impl PlaybackHandle {
    pub fn attach(output: &AudioOutput, source: DecoderSource, volume: f32, paused: bool) -> Self {
        let inner = RodioPlayer::connect_new(output.mixer());
        inner.set_volume(volume);
        if paused {
            inner.pause();
        }
        inner.append(source);
        Self { inner }
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
        self.inner.empty()
    }
}
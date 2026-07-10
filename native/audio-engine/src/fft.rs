use parking_lot::Mutex;
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::sync::Arc;

/// 每次 FFT 的样本数
const FFT_SIZE: usize = 2048;
/// 输出频段数
const OUTPUT_BINS: usize = 128;
/// 分析频率范围
const MIN_FREQ: f32 = 80.0;
const MAX_FREQ: f32 = 2000.0;
/// 环形缓冲区最大样本数
const MAX_BUFFER_SIZE: usize = 8192;

/// FFT 频谱分析器，接收单声道样本并输出频谱数据
pub struct FftAnalyzer {
    /// 双声道 f32 样本环形缓冲区（由播放线程写入）
    sample_buffer_l: Mutex<Vec<f32>>,
    sample_buffer_r: Mutex<Vec<f32>>,
    /// FFT 输入采样率
    sample_rate: u32,
    /// 缓存的 FFT 计划（避免每次分析时重建）
    fft_plan: Arc<dyn Fft<f32>>,
    /// 预分配的 FFT 工作缓冲区（避免每次 analyze 分配）
    work: Mutex<FftWorkBuffers>,
}

/// 预分配的 FFT 工作缓冲区
struct FftWorkBuffers {
    windowed_l: Vec<Complex<f32>>,
    windowed_r: Vec<Complex<f32>>,
    output_l: Vec<f32>,
    output_r: Vec<f32>,
}

impl FftAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let fft_plan = planner.plan_fft_forward(FFT_SIZE);

        Self {
            sample_buffer_l: Mutex::new(Vec::with_capacity(MAX_BUFFER_SIZE)),
            sample_buffer_r: Mutex::new(Vec::with_capacity(MAX_BUFFER_SIZE)),
            sample_rate,
            fft_plan,
            work: Mutex::new(FftWorkBuffers {
                windowed_l: vec![Complex::new(0.0, 0.0); FFT_SIZE],
                windowed_r: vec![Complex::new(0.0, 0.0); FFT_SIZE],
                output_l: vec![0.0; OUTPUT_BINS],
                output_r: vec![0.0; OUTPUT_BINS],
            }),
        }
    }

    /// 推入解码后的单声道样本（由播放线程调用）
    pub fn push_samples(&self, samples_l: &[f32], samples_r: &[f32]) {
        let mut buf_l = self.sample_buffer_l.lock();
        let mut buf_r = self.sample_buffer_r.lock();
        buf_l.extend_from_slice(samples_l);
        buf_r.extend_from_slice(samples_r);
        // 只保留最新的样本
        if buf_l.len() > MAX_BUFFER_SIZE {
            let drain_count = buf_l.len() - MAX_BUFFER_SIZE;
            buf_l.drain(..drain_count);
            buf_r.drain(..drain_count);
        }
    }

    /// 应用 Hamming 窗到样本上，将结果存储在 windowed 缓冲区中
    fn apply_window(&self, samples: &[f32], windowed: &mut [Complex<f32>]) {
        for (i, (&s, w)) in samples.iter().zip(windowed.iter_mut()).enumerate() {
            let ham = 0.54
                - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE as f32 - 1.0)).cos();
            *w = Complex::new(s * ham, 0.0);
        }
    }

    /// 转化为 dB 并归一化到 [0, 1]
    fn to_normalized_db(&self, avg: f32) -> f32 {
        let db = 20.0 * (avg + 1e-10).log10();
        ((db + 60.0) / 60.0).clamp(0.0, 1.0)
    }

    /// 计算频谱，返回左右声道 (ldata, rdata) 各 OUTPUT_BINS 个值，范围 [0.0, 1.0]
    pub fn analyze(&self) -> (Vec<f32>, Vec<f32>) {
        let buf_l = self.sample_buffer_l.lock();
        let buf_r = self.sample_buffer_r.lock();
        if buf_l.len() < FFT_SIZE {
            return (vec![0.0; OUTPUT_BINS], vec![0.0; OUTPUT_BINS]);
        }

        // 取最新的 FFT_SIZE 个样本
        let start = buf_l.len() - FFT_SIZE;
        let samples_l = &buf_l[start..];
        let samples_r = &buf_r[start..];

        let mut work = self.work.lock();

        // 应用 Hamming 窗（复用预分配的 windowed 缓冲区）
        self.apply_window(samples_l, &mut work.windowed_l);
        self.apply_window(samples_r, &mut work.windowed_r);

        // 释放 sample_buffer 锁（后续计算不需要它）
        drop(buf_l);
        drop(buf_r);

        // 执行 FFT（使用缓存的计划，原地处理）
        self.fft_plan.process(&mut work.windowed_l);
        self.fft_plan.process(&mut work.windowed_r);

        // 将频率段映射到输出频段
        let freq_per_bin = self.sample_rate as f32 / FFT_SIZE as f32;
        let min_bin = (MIN_FREQ / freq_per_bin).floor() as usize;
        let max_bin = ((MAX_FREQ / freq_per_bin).ceil() as usize).min(FFT_SIZE / 2);

        if min_bin >= max_bin {
            work.output_l.iter_mut().for_each(|v| *v = 0.0);
            work.output_r.iter_mut().for_each(|v| *v = 0.0);
            return (work.output_l.clone(), work.output_r.clone());
        }

        // 使用对数间距分配输出频段
        let log_min = MIN_FREQ.ln();
        let log_max = MAX_FREQ.ln();

        for i in 0..OUTPUT_BINS {
            let freq_lo = (log_min + (log_max - log_min) * i as f32 / OUTPUT_BINS as f32).exp();
            let freq_hi =
                (log_min + (log_max - log_min) * (i + 1) as f32 / OUTPUT_BINS as f32).exp();

            let bin_lo = ((freq_lo / freq_per_bin).floor() as usize).max(min_bin);
            let bin_hi = ((freq_hi / freq_per_bin).ceil() as usize).min(max_bin);

            if bin_lo >= bin_hi {
                work.output_l[i] = 0.0;
                work.output_r[i] = 0.0;
                continue;
            }

            // 取该范围内的平均幅度（直接从 windowed 的前半部分计算，跳过 magnitudes 中间 Vec）
            let mut sums: (f32, f32) = (0.0, 0.0);
            for j in bin_lo..bin_hi {
                sums.0 += work.windowed_l[j].norm() / FFT_SIZE as f32;
                sums.1 += work.windowed_r[j].norm() / FFT_SIZE as f32;
            }
            let avgs = (sums.0 / (bin_hi - bin_lo) as f32, sums.1 / (bin_hi - bin_lo) as f32);

            // 转为 dB 并归一化到 [0, 1]
            work.output_l[i] = self.to_normalized_db(avgs.0);
            work.output_r[i] = self.to_normalized_db(avgs.1);
        }

        (work.output_l.clone(), work.output_r.clone())
    }

    /// 重置样本缓冲区（例如 seek 时）
    pub fn reset(&self) {
        let mut buf_l = self.sample_buffer_l.lock();
        let mut buf_r = self.sample_buffer_r.lock();
        buf_l.clear();
        buf_r.clear();
        buf_l.shrink_to(MAX_BUFFER_SIZE);
        buf_r.shrink_to(MAX_BUFFER_SIZE);
    }
}

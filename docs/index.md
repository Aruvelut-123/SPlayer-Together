---
# https://vitepress.dev/reference/default-theme-home-page
layout: home

hero:
  name: "SPlayer-Next"
  text: "听音乐，本该如此"
  tagline: 一款简洁而精致的多平台桌面音乐播放器。支持多种音频格式与丰富的歌词展现形式，性能经过深度优化，每一处细节都恰到好处。
  actions:
    - theme: brand
      text: 立即下载
      link: /download
    - theme: alt
      text: 使用指南
      link: /guide
    - theme: alt
      text: GitHub
      link: https://github.com/SPlayer-Dev/SPlayer-Next

features:
  - icon: 🎵
    title: 广泛的格式支持
    details: 基于 FFmpeg + Rust 的高性能音频引擎，支持 MP3、FLAC、WAV、AAC、OGG、APE 等众多格式，渐入渐出、音量均衡、均衡器一应俱全。
  - icon: 📝
    title: 丰富的歌词展现
    details: 支持 LRC / QRC / YRC / TTML 多种歌词，逐字高亮与翻译，并提供桌面歌词、灵动岛、Windows 任务栏歌词等多种展现形式。
  - icon: 🌐
    title: 流媒体服务
    details: 接入 Subsonic / Navidrome / Jellyfin / Emby 等自建流媒体服务器，多服务器管理、自动连接，随时随地访问你的曲库。
  - icon: 🎧
    title: 系统级集成
    details: 对接系统媒体控制（Windows SMTC / Linux MPRIS / macOS Now Playing）与 Discord 状态，锁屏、通知栏、耳机线控皆可掌控。
  - icon: 🎨
    title: 自适应主题
    details: 封面取色驱动全站着色，Light / Dark / Auto 自动切换，音乐频谱可视化，细节处处打磨。
  - icon: 🧩
    title: 可扩展能力
    details: 内置插件系统与外部 API（HTTP + WebSocket），可编写脚本扩展音源，或通过接口远程控制播放。
---

# Firefly AI Engine (萤火虫端侧推理引擎)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![React 19](https://img.shields.io/badge/React-19.2-61dafb.svg)](https://react.dev/)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.0-FFC131.svg)](https://tauri.app/)
[![llama.cpp](https://img.shields.io/badge/Engine-llama.cpp-orange.svg)](https://github.com/ggerganov/llama.cpp)

**Firefly AI Engine** 是专为 **Firefly AI Folder** 设计的独立外置、高可用端侧 AI 推理与模型管理平台（Tier 2 分级架构）。项目采用 **Tauri 2 (Rust Core) + React 19 + Tailwind CSS v4 + shadcn UI** 构建，旨在以超低资源占用（~15MB 独立应用包体、~25MB 闲置内存）提供生产级端侧大语言模型与多模态视觉模型的调度、推理与下载生命周期管理。

---

## 🌟 核心特性 (Key Features)

### 1. 🚀 1:1 对等移植的生产级推理调度矩阵
- **Max-Fill 显存自适应卸载**：
  - **Apple Silicon (Metal UMA)**：预留 3GB 系统运行开销，其余统一内存全部卸载，批大小设为 1024/512；
  - **集成显卡 / 核显 (iGPU)**：安全可用显存按 1.8~3.5GB 动态折算，按比例安全卸载 8~16 层，防止爆系统共享内存；
  - **独立显卡 (dGPU)**：预留 0.8GB 运行缓冲，可用显存容纳比 $\ge 88\%$ 时全量 GPU 加速 (`-ngl -1`)，装不下时精准压榨卸载层数；
- **核心防崩溃断言**：动态自适应微批计算，强制保证 `ubatch <= batch`，从根本上杜绝 `llama.cpp` 底层触发 `0xC0000005` 内存访问冲突；
- **Flash Attention 智能判定**：非 CPU + 非 Vulkan + 硬件计算能力支持（Turing 7.5+ 架构）时自动启用 `-fa auto`，其余场景安全回退；
- **CPU 留核调度**：永远保留至少 2 个物理核心给操作系统与前台 UI，`-t` 线程数自适应控制在 2~8 之间。

### 2. 🛡️ Windows 8.3 短路径安全防护
- 深度解决 C/C++ 底层程序处理包含中文、非 ASCII 字符或空格路径时的乱码截断与崩溃异常；
- 具备 `chcp 65001` 与系统活动代码页双向解码及 `fs.existsSync` 双重物理校验。

### 3. ⚡ DSpark 与 MTP 投机采样加速 (Speculative Sampling)
- 支持 DSpark 草稿模型配对（`--spec-type draft-dspark --spec-draft-n-max 5`），草稿模型同步全量卸载至 GPU，大幅提升小参数模型生成速率；
- 支持 MTP 预测草稿模型（`draft-mtp`）。

### 4. 🌐 双轨高速断点续传下载器与 10 语种模型元数据
- **网络探针与自动镜像**：300ms 快速探测网络，国内环境自动走 GitHub 代理与 ModelScope；海外环境直连 HuggingFace 与 GitHub 官方 Release；
- **内置 10 语种官方元数据包**：内嵌 `zh-CN`, `en-US`, `ja-JP`, `ko-KR`, `fr-FR`, `de-DE`, `es-ES`, `ru-RU`, `pt-PT`, `ar-EG` 的模型推荐与显存智能推导；
- **多模态投影器自动挂载**：针对多模态视觉模型，自动识别并关联下载 `--mmproj` 视觉投影器文件。

### 5. 🎛️ 多后端热切换管理
- 支持 **Vulkan (GPU通用)**、**CPU (AVX2)**、**CUDA 12.4 (NVIDIA极致加速)** 及 **Metal (macOS)**；
- 未安装后端支持一键断点下载并自动解压部署至 `bin/` 对应子目录。

---

## 🛠️ 技术栈 (Tech Stack)

- **主宿主**：Tauri 2 (Rust)
- **前端视图**：React 19.2 + TypeScript 5.9 + Tailwind CSS v4 + shadcn UI
- **构建工具**：Vite 6.4 + Vitest 3.2
- **状态管理**：Zustand 5
- **图标库**：Lucide React
- **推理后端**：llama.cpp (llama-server)

---

## 📦 目录结构 (Directory Layout)

```text
apps/firefly-ai-engine/
├── src/
│   ├── api/                     # 独立 API 客户端与高仿真 Mock 桥接
│   ├── assets/
│   │   └── models/              # 内嵌 10 语种官方推荐模型元数据
│   ├── components/
│   │   ├── common/              # 语言切换等公共组件
│   │   ├── engine/              # 计算引擎表格 (1:1 移植)
│   │   ├── hardware/            # 硬件检测与驱动降级诊断卡片
│   │   ├── model/               # 双轨模型库与断点下载
│   │   ├── monitor/             # 显存监控与推理参数微调
│   │   ├── storage/             # 模型存储目录自定义选择器
│   │   └── ui/                  # shadcn UI 基础原子组件
│   ├── hooks/                   # useModelDownload, useEngineDownload 等状态机 Hook
│   ├── lib/
│   │   ├── command-builder.ts   # 生产级 llama-server 动态命令行构建器
│   │   ├── i18n/                # 10 语种全局响应式多语言状态
│   │   ├── model-metadata-service.ts # 语言推荐模型与显存推导服务
│   │   ├── model-resolver.ts    # 1:1 对等移植模型物理路径解析器
│   │   ├── path-utils.ts        # Windows 8.3 短路径安全转换工具
│   │   ├── region-detector.ts   # 网络探针与镜像路由
│   │   └── unified-model-manager.ts # 统一模型管理器与投机配对
│   ├── stores/                  # 引擎全局状态管理
│   ├── App.tsx                  # 独立控制中心视窗
│   └── main.tsx
├── src-tauri/                   # Tauri 2 原生 Rust Core
└── tests/                       # 全量 Vitest 单元与组件测试套件
```

---

## 🚀 快速开始 (Getting Started)

### 安装依赖

```bash
pnpm install
```

### 启动开发环境

```bash
pnpm dev
```

### 运行自动化测试

```bash
pnpm test
```

### 生产环境构建

```bash
pnpm build
```

---

## 📄 开源许可证 (License)

本项目基于 [MIT License](LICENSE) 开源协议。

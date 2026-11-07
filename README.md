# Prompt Lab

面向本地出图工作流的**提示词工作台**：一个自托管的 Web 服务，把「写提示词」这件事按模型族的规则体系编译出来。

不是通用 ChatGPT 套壳——它内置了多套不同模型族的提示词范式、一个可反查 Danbooru 的标签系统、以及一条「先多模态模型看图、拒答再降级本地打标」的反推流水线。

```
┌──────────┐
│ 浏览器    │
└────┬─────┘
     │ HTTP :33002
┌────▼──────────────────────────────┐
│  prompt-lab-web  (Node + Express) │
│  ├─ 规则引擎：多族范式编译          │
│  ├─ 反推流水线：VLM → WD14 降级     │
│  ├─ 标签服务：Danbooru 代理         │
│  └─ 角色库：标签核验 + 语义检索      │
└──┬─────────────────┬──────────────┘
   │ OpenAI 兼容 API   │ HTTP :33001
┌──▼──────────────┐ ┌─▼─────────────────┐
│ 任意 LLM 服务    │ │ prompt-lab-wd14   │
│ (自建/云厂商)    │ │ WD14 ONNX · CPU   │
└─────────────────┘ └───────────────────┘
```

---

## 它解决什么问题

手工写提示词有三个反复出现的坑，这个工具针对性地处理：

**1. 不同模型族的语法不能混用。** NoobAI 认 `very awa`、Anima 不认；Krea 2 用纯自然语言、写成标签堆砌就废了；MOSS-Image 有 `<|区块|>` 分块协议。工作台把每个族的规则做成独立的编译管线，选错族的词会被后处理确定性剔除。

**2. 看图反推常常拿不到有效结果。** 带安全策略的多模态模型遇到敏感图会拒答，而很多拒答是**软回避**——它不说不，而是写成 "there's no explicit content here"，然后描述一件根本没穿的衣服。工作台有一套拒答检测（强拒答 / 软回避 / 元话语 / 过短四路信号），判定失败就自动降级到本地 WD14 打标器。

**3. 迭代几轮后提示词会自我污染。** 反复「在原基础上改」，容易积累同义重复、姿势矛盾、丢掉该族的自然语言段。工作台在迭代/润色两条链路上做了形态校验与降级处理。

---

## 功能

七个页签：

| 页签 | 作用 |
|---|---|
| **生成** | 从一段需求描述编译出完整正向/负面提示词 |
| **反推** | 上传图片或给路径，反推出提示词（VLM 优先，拒答降级 WD14） |
| **润色** | 把已有的提示词改写成目标族的规范格式 |
| **迭代** | 在上一版基础上按新要求增量修改 |
| **标签** | Danbooru 标签搜索：热度、释义、同图共现、示例图 |
| **角色** | 角色库检索：标签核验 + 语义检索，修正日语姓名语序 |
| **规则** | 查看/编辑族的规则与预设（JSON 直改） |

另有相机角度雷达图：拖拽选方位/仰俯/景别，按 Multiple-Angles LoRA 的标准词表生成机位描述。

---

## 支持的模型族

| 族 | 范式 | 适用 |
|---|---|---|
| **NoobAI / 光辉系** | Danbooru 标签流 | SDXL 系动漫模型 |
| **Anima** | 标签段 + 自然语言混排 | Qwen 系文本编码器 |
| **Krea 2** | 纯英文自然语言 | Qwen3-VL 编码器 |
| **通用** | Danbooru 标签流 | 其它 SDXL 衍生 |
| **MOSS-Image** | caption / tag 串 / Layout JSON 三形态 | OpenMOSS 官方规范 |

族的定义在 `web/rules.json`，共用的写作纪律在 `sharedBlocks` 里复用。

### MOSS-Image 的 Layout 编译

MOSS-Image 支持用边界框控制画面元素位置。官方规范里模型吃的是
`abs_centralized` / `yxyx`（画布中心为原点）坐标，而人写草稿用的是
`abs` / `xyxy`（左上角原点）。

工作台的做法是**让模型只写草稿，坐标换算交给代码**（`web/moss-layout.js`）——
官方明确要求模型不做算术，让 LLM 自己算中心化坐标基本必错。编译器语义与官方
`compile_prompt.py` 对齐，含取整规则、边界校验、未知字段拒绝。

规则依据 [OpenMOSS/MOSS-Image](https://github.com/OpenMOSS/MOSS-Image)（Apache-2.0）。

---

## 配置模型服务

工作台不绑定任何厂商。**API 地址、密钥、模型都可以在界面里配**，保存即生效，不用重启。

### 界面上配（推荐）

打开右上角 **🔌 设置** 页：

1. 填 **API 地址**（baseURL，通常以 `/v1` 结尾）
2. 填 **API Key**（保存后只显示掩码，永不回显）
3. 点 **获取模型列表** —— 会请求 `GET /models` 并列出可用模型
4. 选一个做 **默认模型**，点 **保存**

服务不支持 `/models` 接口时可以跳过第 3 步，直接手填模型名。

「生成 / 润色 / 迭代」页的模型下拉框会跟着更新。

### 用环境变量配（适合容器编排）

环境变量的优先级**高于**界面设置，适合 CI/编排场景一次注入：

| 变量 | 作用 |
|---|---|
| `LLM_BASE_URL` | API 地址 |
| `WORKBUDDY_API_KEY` | API 密钥（变量名可在 `config.json` 的 `llm.apiKeyEnv` 改） |
| `SETTINGS_DIR` | 运行时设置的存放目录（默认 `./data`） |
| `PORT` / `HOST` | 服务监听地址 |

> 若 `apiKey` 来源是环境变量，界面里填的值不会覆盖它——「设置」页会标明来源。

### 配置优先级

```
环境变量  >  data/settings.json（界面保存的）  >  config.json（出厂默认）
```

### 密钥怎么存

- 密钥单独存 `data/llm-key.txt`，权限 `600`
- **不写进** `settings.json`，不写进 `config.json`，不写进任何提交的文件
- 前端只能拿到 `hasApiKey` 布尔值和掩码，拿不到真值
- `data/` 已在 `.gitignore` 中

### 支持的接口

任何 OpenAI 兼容的 `/v1/chat/completions`：

- 自建网关（one-api / new-api / LiteLLM 等）
- Ollama、vLLM、llama.cpp（需兼容 OpenAI 路径）
- OpenAI、DeepSeek、通义、Moonshot 等云厂商

反推功能额外要求该模型支持 `image_url` 多模态输入。

---

## 使用方法

### 典型流程

**从零生成**

1. 选目标族 → 填需求（越具体越好）→ 点「生成」
2. 右侧出正向/负面 + 采样参数，底部显示字数
3. 复制到你的出图工具

**反推一张图**

1. 切「反推」页 → 选图或填图片路径
2. 引擎选 `auto`：先试多模态模型，模型拒答/失败自动降 WD14
3. 结果会标注走的是哪条通道、耗时多少、拒答原因是什么

**迭代**

1. 「迭代」页粘上一版正向/负面
2. 写这一轮要改什么（例：「把光线改成傍晚」「加一顶帽子」）
3. 只改你指明的部分，其余保留；形态会按族规范自动补齐

### HTTP API

界面之外也可以直接调：

```bash
# 生成
curl -s -X POST http://127.0.0.1:33002/api/compose \
  -H 'Content-Type: application/json' \
  -d '{"mode":"gen","family":"anima","brief":"白发少女站在窗边，白天"}'

# 反推（传 base64 或路径）
curl -s -X POST http://127.0.0.1:33002/api/reverse \
  -H 'Content-Type: application/json' \
  -d '{"family":"anima","path":"/images/a.jpg","engine":"auto"}'

# 标签搜索
curl -s 'http://127.0.0.1:33002/api/tags?q=long%20hair&limit=10'
```

`mode` 取 `gen` / `refine` / `iterate` / `reverse`。
`engine` 取 `auto` / `vlm` / `wd14`。

---

## 实现方式

### 技术栈

- **Web**：Node.js ≥18 + Express 4，唯一依赖就是 express（不引 SDK，LLM 客户端手写 fetch）
- **前端**：单文件 `public/index.html`，原生 JS，无构建步骤、无框架
- **WD14 服务**：Python + FastAPI + onnxruntime（CPU 推理）
- **容器**：两个独立镜像，compose 编排

不用前端框架是有意的：整个界面一个文件，改起来直接改，不需要 node_modules 和打包链。

### 目录结构

```
.
├── web/
│   ├── server.js        # HTTP 路由与编排
│   ├── engine.js        # 规则引擎（纯函数）：提示词拼装、格式清洗、格式校验
│   ├── llm.js           # OpenAI 兼容客户端（含 vision）
│   ├── vlm.js           # 拒答检测：区分「真拒答」与「软回避」
│   ├── moss-layout.js   # MOSS-Image Layout 草稿编译器
│   ├── settings.js      # 运行时设置（URL/key/模型，密钥单独落盘）
│   ├── services.js      # Danbooru / OpenViking 客户端
│   ├── character.js     # 角色标签核验与修正
│   ├── rules.json       # 族规则（多族 + 共享纪律块 + 用词规范）
│   ├── config.json      # 出厂默认配置（不含密钥）
│   ├── data/            # 运行时设置（自动生成，含密钥，不入库）
│   ├── public/index.html
│   └── Dockerfile / docker-compose.yml
├── wd14/
│   ├── server.py        # /health /tags /warmup
│   └── Dockerfile / docker-compose.yml
└── .env.example
```

### 关键设计

**规则引擎是纯函数。** `engine.js` 不碰网络、不碰文件，输入族规则 + 用户参数，输出提示词文本。所以它可以脱离服务单测——`test-engine.mjs` 52 项断言全跑在纯函数上。

**后处理是确定性的，不靠模型自觉。** 模型被反复要求「不要写质量词」仍会漏回来，所以有一层 `stripQualityAndSafety()` 硬清除（含 `(masterpiece:1.2)`、`score_9` 这类写法）。同理，族不允许的语法（画师标签、`BREAK`、下划线）也在后处理里强制清掉。

**反推做成显式状态机，而不是一次 try。** VLM 成功就直接返回；明确拒答（含软回避）就降级 WD14 并把拒答原因写进备注；`engine=vlm` 时则不降级、直接报错——让你知道是模型不行还是图不行。

**只告警不改写。** 形态校验（如「这一版缺自然语言段」）只提出问题，不擅自重写用户的创作意图。

### 测试

```bash
cd web
node test-engine.mjs    # 规则引擎：JSON 宽容解析、格式清洗、长度统计、系统提示拼装
node test-layout.mjs    # Layout 编译器：官方换算向量、边界校验
node test-refusal.mjs   # 拒答检测：强拒答 / 软回避 / 正常输出
node test-settings.mjs  # 设置：优先级、密钥不回显、原子写入
node test-services.mjs  # 外部服务客户端（需网络）
```

前三个不需要网络。

---

## 部署方式

### 前置条件

- Docker + docker compose
- 一个 OpenAI 兼容的 LLM 服务（自建网关 / 云厂商 API 都行）
- 可选：Danbooru 可访问（标签功能）；OpenViking（语义检索）

### 1. 准备配置

```bash
git clone <your-repo-url> prompt-lab
cd prompt-lab
cp .env.example .env
```

`.env` 可以留空——**启动后在界面「设置」页配更简单**（见上一节）。

如果偏好环境变量方式，填这两行：

```bash
WORKBUDDY_API_KEY=你的key
LLM_BASE_URL=https://api.example.com/v1
```

> `.env` 已被 `.gitignore` 忽略。密钥只走环境变量或 `data/llm-key.txt`，不写进任何提交的文件。

### 2. 准备 WD14 模型

WD14 需要一个 ONNX 模型和标签表，放到 `wd14/data/models/wd14/`：

```
wd14/data/models/wd14/
├── model.onnx          # WD14 标签分类器（约 446MB）
├── selected_tags.csv   # 标签表
└── config.json
```

模型可从 [SmilingWolf/wd-v1-4-moat-tagger-v2](https://huggingface.co/SmilingWolf/wd-v1-4-moat-tagger-v2) 等来源获取。

> 体积较大，已在 `.gitignore` 中排除，不入库。

### 3. 启动

```bash
cd wd14 && docker compose up -d --build
cd ../web && docker compose up -d --build
```

### 4. 验证

```bash
curl -s http://127.0.0.1:33001/health                    # WD14
curl -s http://127.0.0.1:33002/api/config | head -c 200   # Web
```

打开 `http://<host>:33002`。

### 前端改动要重新构建

`public/index.html` 和所有 `.js` 都是打进镜像的（没有挂载），所以改完要：

```bash
docker compose up -d --build
```

只 `restart` 不生效——这个坑很容易踩。

---

## 使用的模型

### 文本模型（可换）

工作台**不绑定任何特定模型**，只要服务是 OpenAI 兼容的 `/v1/chat/completions`。
默认配置里给的是一组示例（`web/config.json` 的 `llm.models`），换成你自己的即可。

对模型的要求：

| 用途 | 要求 |
|---|---|
| 生成 / 润色 / 迭代 | 能遵循结构化 JSON 输出，长上下文（系统提示约 10-25k token 视族而定） |
| 反推（VLM） | 需要支持 `image_url` 多模态输入 |

一个实测经验：**不同模型对输出格式的服从度差别很大**。有的模型收到「只输出 JSON」会顺从格式但自创 schema，所以在系统提示首尾各锚一次、并在用户消息里把「positive 字段放什么」说破，比只在末尾要求一次可靠得多。

### 反推用的模型

按优先级：

1. **多模态 LLM**（`vlm.model`，留空则跟随默认模型）—— 直接看图写描述
2. **WD14**（本地 ONNX，CPU 推理）—— 兜底，输出 Danbooru 标签

WD14 的价值不在精度，而在**它不会拒答**：它本身就是 Danbooru 标签分类器，对 NSFW 内容照常输出标签。所以「VLM 优先 + WD14 兜底」这条链路能覆盖 VLM 拒绝的那部分图。

代价是 WD14 只出标签、不出自然语言，需要再交给 LLM 整理成目标族格式。

---

## 客户端与工具链

| 环节 | 用什么写的 |
|---|---|
| 代码编写 | 主要在 **DeepSeek Harness**（DSH）会话中迭代完成 |
| 写代码的模型 | 通过自建 OpenAI 兼容网关接入的大模型（DeepSeek / GLM 系列等） |
| 编辑器 | VS Code |
| 版本管理 | Git + GitHub CLI |
| 容器运行时 | Docker + docker compose |

代码本身没有任何 AI 框架依赖——是普通的 Node 服务，纯手写 fetch，不引 LLM SDK。

---

## 已知限制

1. **无 GPU 时的反推质量**：WD14 只出标签，自然语言描述依赖后续 LLM 整理。
2. **OpenViking 检索是可选的**：不配也能用，只是角色库少一层语义召回。
3. **前端无构建链**：单文件 index.html，功能变多后维护性会下降。
4. **规则页保存需要可写挂载**：默认只读，要保存需配 `RULES_WRITE_PATH`。
5. **设置页无鉴权**：服务本身不内置登录，暴露到公网前请自行加反代鉴权。
6. **提示词长度有实测上限**：anima/krea2 建议 440 token（约 300 词）以内、硬上限 580；
   noobai/generic 是 77 token 的 CLIP 硬分块（超出静默丢弃）。超出会告警但不自动裁剪。
   详见下节。

---

## 提示词长度与重复：实测结论

2026-11 本机做过一轮 A/B（同一 seed、同一模型，只改提示词长度），结论与社区流传的数字不太一样：

### 长度不是主因

| 长度档 | 结果 |
|---|---|
| ~100 token | 基准，干净 |
| ~240 / ~380 token | 正常 |
| **~510 token** | 结构完好，但半身→中景，发带等低权重细节消失 |
| **~750 token** | 人物朝向开始偏离 `looking at viewer` |
| **~920 token** | **结构依然完整**，只是细节继续流失 |

Anima 用 Qwen 系编码器，**不做硬截断**（`max_length` 实际是 99999999），
所以长提示词不会"截断崩溃"，而是**低权重信息被稀释**。

### 重复比长度更致命

把同一句 `Neon light glows across the wet street` **重复 25 次**（仅 345 token）：

- 人物结构完全正常
- 但 `green jacket` 被染成了**荧光亮绿**——重复把该概念的权重放大到压过其它描述

反过来，50 句**互不重复**的描述（920 token）画面依然干净。

**所以写长提示词的正确姿势是引入新维度（材质/道具/构图/景深/天气），不是同义复述。**

### 落地的阈值

| 族 | 建议上限 | 硬上限 | 说明 |
|---|---|---|---|
| anima / krea2 | 440 token（≈300 词） | 580 token（≈400 词） | Qwen 编码器，无硬截断 |
| noobai / generic | 75 token | 77 token | SDXL CLIP 硬分块，超出静默丢弃 |
| moss | 1200 token | 2000 token | 官方条件上限 4096 |

超限会在结果区显示告警（含具体 token 数与建议），**不自动裁剪**——
裁掉内容会破坏画面语义，宁可提示让你自己决定。

`measureLength()` 同时统计**重复度**：某句重复 ≥3 次或近似重复 ≥30% 时也会告警。

---

## 授权

本仓库代码可自由使用与修改。

`web/rules.json` 中 MOSS-Image 族的规则依据 OpenMOSS 官方文档（Apache-2.0）编写。
Tags 与图库数据来自 [Danbooru](https://danbooru.donmai.us/)。

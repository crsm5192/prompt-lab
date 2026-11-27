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

在「高级 → 思考强度」可为生成、润色、迭代和反推中的模型调用选择低、中或高。选「模型默认」时由模型服务决定。提交后，操作按钮显示当前任务，结果区显示已用秒数，直到任务完成或报错。

在生成或润色页的「提示词柜」中，添加条目时只需填写名称和内容。勾选一个或多个条目，在每行切换「融合」或「前置」，两种用法可混用。「融合」由文本模型结合画面改写，适合画风、光线、材质。「前置」按勾选顺序原样写入正向提示词开头，适合 LoRA 触发词和固定标签。MOSS Layout 的前缀写入 `summary.caption`。条目保存在 NAS 数据卷的 `prompt-cabinet.json` 中，多设备共享。勾选顺序和开关只对当前页面有效，刷新后旧条目使用原先保存的用法，新条目默认融合。

---

## 支持的模型族

| 族 | 范式 | 适用 |
|---|---|---|
| **NoobAI / 光辉系** | Danbooru 标签流 | SDXL 系动漫模型 |
| **Nibbles / Noob2** | 中日英自然语言、空格标签、可选 bbox | Nibbles 内测模型 |
| **Anima** | 标签段 + 自然语言混排 | Qwen 系文本编码器 |
| **Krea 2** | 纯英文自然语言 | Qwen3-VL 编码器 |
| **通用** | Danbooru 标签流 | 其它 SDXL 衍生 |
| **MOSS-Image** | caption / tag 串 / Layout JSON 三形态 | OpenMOSS 官方规范 |

族的定义在 `web/rules.json`，共用的写作纪律在 `sharedBlocks` 里复用。

生成与润色默认进行艺术构图：围绕主体安排焦点、留白、动作线、明暗大形、色彩和材质。界面可选择自动、保留已有构图、偏置留白、对角动势、框景层次或几何节奏。动作描述重点说明可见手脚的归属、承重与物体接触，保持指定动作和机位。反推忠实还原原图，局部迭代只改反馈要求。规则减少提示词歧义；实际人体和画面质量仍需在目标出图模型、工作流和种子下验证。

### Nibbles / Noob2

Noob2 暂时沿用 Anima 的正向长度预算。生成与润色优先约 180–240 个估算 token，超过 300 会尝试精简，超过 380 会提示超长。迭代需重组至 300 以内。本地编排和标签转换显示长度提示并保留完整正文。

打开 `/?family=noob2` 或 `/?family=nibbles` 可直接进入这个模型族。生成页的「本地编排」按画面描述识别语言和媒介，保留输入正文。使用文本模型生成、润色或迭代时，可把画师、画幅等要求写入任务描述。图片反推沿用 VLM / WD14 配置。

润色页的「转换标签」可在没有文本模型的情况下使用。原生模式把正负组分开、移除数值权重和强调括号、保留画师与引用文字。「SD 权重兼容」按附件转换器的约定保留数值和括号层级，供支持 SD 加权语法的工作流使用。转换后的正负提示词可以一起送入「迭代」。

本地接口为 `POST /api/nibbles/assemble`（至少提供 `brief`）和 `POST /api/nibbles/convert`（提供 `source`，可选 `profile=native|sd`）。生成与反推接口的 `family` 均接受 `nibbles` 和 `noob2`。NAS 上的规则单独挂载，发布新版 Web 后按 `ops/README.md` 的规则发布流程合并 `families.nibbles`。

### 任务日志

任务诊断日志按北京时间每天写入 `web/data/logs/YYYY-MM-DD.jsonl`（容器内 `/data-settings/logs/`）。在 NAS 上按页面报错中的请求编号检索即可关联整次操作和每次模型调用。日志保存耗时、状态、结束原因、输出长度和重试次数，提示词正文、图片、密钥和网关错误原文均不入日志。历史文件保留在数据卷内。

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

**规则引擎是纯函数。** `engine.js` 不碰网络、不碰文件，输入族规则 + 用户参数，输出提示词文本。所以它可以脱离服务单测——`test-engine.mjs` 61 项断言全跑在纯函数上。

**后处理是确定性的，不靠模型自觉。** 模型被反复要求「不要写质量词」仍会漏回来，所以有一层 `stripQualityAndSafety()` 硬清除（含 `(masterpiece:1.2)`、`score_9` 这类写法）。同理，族不允许的语法（画师标签、`BREAK`、下划线）也在后处理里强制清掉。

**反推做成显式状态机，而不是一次 try。** VLM 成功就直接返回；明确拒答（含软回避）就降级 WD14 并把拒答原因写进备注；`engine=vlm` 时则不降级、直接报错——让你知道是模型不行还是图不行。

**输出格式验收。** 生成、润色、迭代和反推都检查空值、占位内容和族的书写形态。不合规时最多补一次格式修正；仍不合规会在 `validation` 和备注里明确告警。关闭反推整理时不额外调用模型。修正保留用户指定的画面内容。

### 测试

```bash
cd web
node test-engine.mjs    # 规则引擎：JSON 宽容解析、格式清洗、长度统计、系统提示拼装
node test-layout.mjs    # Layout 编译器：官方换算向量、边界校验
node test-refusal.mjs   # 拒答检测：强拒答 / 软回避 / 正常输出
node test-settings.mjs  # 设置：优先级、密钥不回显、原子写入
npm test               # 上述核心测试 + 本地 HTTP/规则/代理/前端集成回归
node test-services.mjs  # 外部服务客户端（需实际配置和网络）
```

核心与集成回归不调用外部模型；集成测试使用本地模拟服务。图像预处理回归在 `wd14` 目录执行 `python -m unittest test_preprocess.py`，需要 Pillow 和 NumPy。GitHub Actions 会运行 Web 与图像输入测试。

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
cp .env.example web/.env
```

`web/.env` 可以留空——**启动后在界面「设置」页配更简单**（见上一节）。

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
└── selected_tags.csv   # 标签表
```

模型可从 [SmilingWolf/wd-swinv2-tagger-v3](https://huggingface.co/SmilingWolf/wd-swinv2-tagger-v3) 获取。本项目按官方流程处理输入：透明图合成白底、居中补方形、缩放到 448、RGB 转 BGR；不要直接拉伸长方形图。

> 体积较大，已在 `.gitignore` 中排除，不入库。

### 3. 启动

```bash
mkdir -p images
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

## NAS 更新与回滚

Windows 上运行 `ops/deploy-nas.ps1` 可同步代码、构建并验证 NAS。它保留 NAS 的 config、规则、密钥、运行时数据和模型文件，记录发布指纹、旧镜像和恢复脚本。操作方法见 [ops/README.md](ops/README.md)。

Web 和 WD14 都把项目根目录 `images/` 挂到容器 `/images`。按路径反推统一使用 `/images/文件名`；上传 base64 仍受支持。

基础镜像按版本和 amd64 摘要固定，Web 使用 lockfile 与 `npm ci`。`APP_VERSION` 控制版本镜像标签，`VCS_REF` 写入镜像 revision；默认构建保留 development 标识。

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
4. **规则更新**：Compose 已配置可写路径；保存先校验结构并备份，宿主机编辑和界面保存都会热更新。坏文件保留上次有效规则，重启时可用备份恢复。
5. **无需登录**：当前服务按内网使用方式开放，设置页和业务接口不设登录。临时查询其他 API 地址时不自动复用已有密钥。
6. **长度是估算和经验告警**：Anima 为 300/380 token，Krea 2 为 440/580；NoobAI/通用为 75/77。超出会告警，不自动裁剪。真实 token 和分块/截断行为由实际出图编码节点决定。
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

| 族 | 建议阈值 | 超限告警阈值 | 说明 |
|---|---|---|---|
| anima | 300 token（≈207 词） | 380 token（≈262 词） | 当前 Anima 经验阈值 |
| krea2 | 440 token（≈303 词） | 580 token（≈400 词） | 当前 Krea 2 经验阈值 |
| noobai / generic | 75 token | 77 token | 分块或截断由具体编码节点决定 |
| moss | 1200 token | 2000 token | 官方条件上限 4096 |

超限会在结果区显示告警（含估算 token 数与建议），**不自动裁剪**——
裁掉内容会破坏画面语义，宁可提示让你自己决定。

`measureLength()` 同时统计**重复度**：某句重复 ≥3 次或近似重复 ≥30% 时也会告警。

### Anima / MOSS 的自动生成优化

选择模型族后自动应用对应策略，无需另加增强关键词。Anima 用短标签前置主体与关键动作，2–3 句正文补接触、姿态、构图和光色；常规生成优先约 180–240 token，复杂明确设定保留至约 300。MOSS 默认普通英文画面描述，主体和动作接触在前，空间布局随后，媒介与材质在后；常规描述优先约 180–280 token，明确标签需求或精确排版需求分别走 tag / Layout。

生成和润色新增一次文本检查：重复句/标签、简洁目标（Anima 300、普通 MOSS 360 token）、单人景别或腾空/接地冲突，以及误伤合法媒介的负面词。发现问题时与格式检查共用一次修正调用，保留指定内容，不直接截断。持续问题显示在 notes；接口 `quality` 返回检查结果，与 `validation` 的格式检查分开。这些简洁目标属于生成器策略，MOSS 的原有长度告警阈值和模型条件上限继续适用。

局部迭代每轮重新组织完整的最终画面状态，保留未修改的设定、触发词与引用文字，替换旧错误表述、合并同义标签和句子，避免累积历轮补丁。迭代按应用估算值验收正向正文上限：Anima 和 Noob2 各 300、普通 MOSS 360、Krea 2 440、标签族 75 token；Layout 结构化数据保持独立规则。普通格式和文本问题共用一次修正；迭代正文超预算时持续重组优化，逐轮收紧写作目标，前轮未缩短时改用更紧凑的结构重写，直到进入上限后再返回。更长的超限中间稿不会累积，不机械截断，不因重组次数达到两次而返回超限失败。浏览器断开请求会取消当前模型调用并停止后续重组；真实模型服务错误仍按服务错误处理。成功结果的 `quality.repairAttempts` 返回实际修正次数，`length.budget.enforced` 标明已执行预算验收；这些数值是写作预算，不是出图编码器的真实 token 上限。反推继续保持忠实还原。

忠实反推不因长度目标自动压缩；局部迭代通过重组文字满足预算，保持未修改的画面设定。引号内的画内文字、多人/分格中的不同景别、用户明确排除的画风及已有负面词受到保护。文本检查不能判断实际出图中的手指数量、头颈完整性或 LoRA 效果；生成器不会修改 ComfyUI 工作流或推断未知 LoRA 设置。

---

## 授权

本仓库代码可自由使用与修改。

`web/rules.json` 中 MOSS-Image 族的规则依据 OpenMOSS 官方文档（Apache-2.0）编写。
Tags 与图库数据来自 [Danbooru](https://danbooru.donmai.us/)。

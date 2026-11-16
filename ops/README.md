# NAS 发布与恢复

在 Windows PowerShell 7 中运行：

```powershell
& .\ops\deploy-nas.ps1 -Service all -ArtifactDirectory .\work\deploy
# 只改 Web 时可用 -Service web
```

默认目标为 `root@10.147.18.102:3322`，项目目录 `/vol1/1000/apps/prompt-lab`；可通过参数覆盖。要求本机已有 SSH 凭据、已确认的主机密钥，以及 tar、git、ssh、scp。脚本不会新增登录鉴权。

每次发布使用时间和源码指纹生成独立版本，记录 revision（未提交时带 dirty）、文件列表和镜像标签。NAS `.releases/<版本>/` 保存旧源码、旧镜像 ID、受保护配置快照和 `rollback.sh`。目录仅 root 可读；配置快照保留在 NAS，不下载密钥。

先构建所有受影响镜像，构建成功才切换容器。健康检查失败会恢复旧源码和镜像。可手工恢复指定版本：

```bash
sh /vol1/1000/apps/prompt-lab/.releases/<版本>/rollback.sh
```

回滚恢复此次替换的源码及旧镜像，保留当前 config、规则、密钥和运行时数据。需要回退配置时由维护者从同目录 `protected-config.tar.gz` 选择恢复，避免覆盖发布期间用户保存的新设置。

源码同步排除了 `.env`、config、规则、运行时数据、模型和图片；部署后要比对核心文件并验收受影响功能。图片统一放在项目根目录 `images/`，两个容器都挂为 `/images`。旧的 `web/images` 如有文件，应在确认重名文件内容后迁入根目录，脚本不会删除或覆盖这些文件。

Web 固定 Node 24.19.0 Alpine 的 amd64 摘要，WD14 固定 Python 3.11.17 slim 的 amd64 摘要。其他架构请用 Docker build 的 `NODE_IMAGE` / `PYTHON_IMAGE` 参数指定相应固定镜像。Web 依赖用 lockfile 和 `npm ci`；测试依赖不进入生产镜像。

镜像版本和 revision 标签放在依赖安装之后，发布版本号变化不会让 npm/pip 依赖缓存失效。

NAS 发布脚本默认使用阿里云 PyPI 镜像加速固定版本依赖下载；可用 `-PythonPackageIndex https://pypi.org/simple` 切回官方源。直接运行 Compose 时默认仍为官方源，可设置 `PYTHON_PACKAGE_INDEX` 覆盖。下载源及源码指纹都记录在版本清单中。

健康检查通过后还需验证：默认模型可调用、目标族格式有效、反推颜色与内容正确、图片路径一致、外部服务数据请求正常。`/api/probe` 的顶层 ok 汇总所有启用依赖；停用的可选服务会标记 disabled，不发请求。

## 单独发布写作规则

源码部署保护 NAS 的 `rules.json`，不会覆盖它。修改规则前将 `/api/rules` 返回的 `rules` 对象保存为基线 JSON；修改后使用三方合并发布：

```powershell
node .\ops\publish-rules.mjs --baseline=.\work\rules-before.json --rules=.\web\rules.json --record=.\work\rules-publish.json
# 检查预览后写入；显式用户任务已授权发布时可直接加 --apply
node .\ops\publish-rules.mjs --baseline=.\work\rules-before.json --rules=.\web\rules.json --record=.\work\rules-publish.json --apply
```

只应用本地相对基线的变化，保留线上其他字段的编辑；同一字段或数组出现冲突会中止。发布记录包含原规则、合并后规则和 NAS 的自动备份路径。规则通过现有 API 保存，保留双挂载的 inode，并立即热更新。规则回退也需单独发布，源码/镜像回滚不会覆盖当前规则。

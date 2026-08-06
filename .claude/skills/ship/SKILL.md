---
description: 灵感熔炉发版工作流 - 质量检查、版本号升级、git tag、推送触发 CI/CD（Docker 镜像 + GitHub Release）的完整发布周期
allowed-tools: Read Write Edit Bash Grep Glob
---

# Ship Release（灵感熔炉）

系统化的发版流程：质量验证 → 版本号 bump → commit → git tag → push 触发 CI/CD。
push `v*` tag 会自动触发两个 workflow：

- `.github/workflows/docker.yml`：构建并推送 `ghcr.io/coracoo/insprira` 镜像
  （tag 规则：`0.1.14`、`0.1`、分支名、短 sha；默认分支额外打 `latest`）
- `.github/workflows/release.yml`：创建 GitHub Release（Release Notes 由 commit/PR 自动生成，不手写 CHANGELOG）

## 何时使用

- 手动调用：准备发布新版本时
- 功能完成、测试全绿之后，打 tag 之前

## 发版前检查（逐条自动验证）

### 1. 质量检查全绿

```bash
npm run check    # node --check server.js 语法检查
npm test         # node --test 全量测试
npm run build    # 编译 Tailwind：css/tailwind-input.css → css/tailwind.css
```

注意：`css/tailwind.css` 是入库文件。只要本次改动碰过 `index.html` 或 `js/**` 的
Tailwind class，必须重跑 `npm run build` 并把产物一起提交，否则样式在发布版里不生效。

### 2. 版本号与 tag 一致性

```bash
grep -m1 '"version"' package.json   # 当前版本号
git tag -l 'v*' --sort=-v:refname | head -3   # 最近的 tag
```

`package.json` 的版本应该等于「即将发布」的版本，且不能落后于最新 tag。
历史教训：版本号 bump 后忘记打 tag，会导致多个版本只有代码没有镜像/Release。

### 3. Git 工作区干净

```bash
git status   # 应为 "nothing to commit, working tree clean"
```

### 4. 安全检查

```bash
# 敏感文件绝不能被 git 跟踪（应为空输出）
git ls-files | grep -E '^(\.env|cookies\.json|data/)' && echo '!!! 有敏感文件被跟踪' || echo 'OK'

# 依赖漏洞扫描（有高危漏洞先修再发）
npm audit --omit=dev
```

项目红线（见 AGENTS.md）：`.env`、`cookies.json`、`data/` 含密钥/登录态，绝不提交；
真实密钥不得写进代码或测试。

## 发版流程

### Step 1: 确定版本 bump 级别

语义化版本（MAJOR.MINOR.PATCH），当前为 0.x 阶段：

- **PATCH**（v0.1.X）：bug 修复、安全修复、样式修正
- **MINOR**（v0.X.0）：新功能、新页面、新 API 端点、新数据源
- **MAJOR**：破坏性变更（0.x 阶段基本不用）

### Step 2: 更新版本号

```bash
npm version --no-git-tag-version 0.1.15   # 只改 package.json / package-lock.json，不自动打 tag
```

### Step 3: 最终验证

```bash
npm run check && npm test && npm run build
git status   # 确认只有 package.json、package-lock.json、css/tailwind.css（如有变化）
```

### Step 4: 提交版本 bump

提交信息用中文（项目约定）：

```bash
git add package.json package-lock.json css/tailwind.css
git commit -m "chore(release): 发布 v0.1.15

- 修复 dashboard 浅色主题对比度问题
- 修复 xhs-mcp baseUrl 协议校验
- 质量检查全部通过（136/136）"
```

如果功能改动还没提交，先把功能 commit 完，版本 bump 单独一个 commit 收尾。

### Step 5: 打 tag

```bash
git tag -a v0.1.15 -m "Release v0.1.15

修复：
- dashboard 浅色主题对比度
- xhs-mcp SSRF 协议走私

测试：136/136 通过"
```

### Step 6: 推送

```bash
git push origin main        # 或当前主分支名，先 git branch --show-current 确认
git push origin v0.1.15
```

push tag 即触发 CI/CD，无需其他操作。

## 发版后验证

### 1. CI/CD 通过

```bash
gh run list --limit 3
gh run watch     # 跟随最近一次运行；docker.yml 要编 amd64+arm64 双平台，耗时较长（10-20 分钟正常）
```

### 2. GitHub Release 已创建

```bash
gh release view v0.1.15
```

### 3. 镜像可用

```bash
docker pull ghcr.io/coracoo/insprira:0.1.15
docker run --rm ghcr.io/coracoo/insprira:0.1.15 node --version
```

## 回滚预案

### Option 1: 补丁版本（首选）

```bash
# 修复问题，走一遍上面的发版流程发 PATCH 版（v0.1.15 → v0.1.16）
```

### Option 2: 撤回 tag（万不得已）

```bash
git tag -d v0.1.15
git push origin :refs/tags/v0.1.15
gh release delete v0.1.15 --yes

git revert HEAD
git push origin main
# 修好后重新打同名 tag 再推（ghcr 镜像会被同名 tag 覆盖重推）
```

## 常见问题

### CI 在 tag push 后失败

docker.yml 双平台构建慢（10-20 分钟），先确认是真失败不是超时等待中。
真失败：在 main 上修复并 push → 删旧 tag（本地+远程）→ 重打同名 tag 重推。

### 发了版本但 Release 没出现

`release.yml` 只在 `v*` tag push 时触发。如果 tag 是 lightweight（`git tag v0.1.15`
没带 `-a`）也会触发，但建议始终用 annotated tag。也可以用
`gh workflow run release.yml -f tag=v0.1.15` 手动补触发。

### 镜像 latest 没更新

`latest` 只在默认分支 push 时更新，tag push 不会动 `latest`。发版后用户应拉
具体版本号（`0.1.15`）或次版本号（`0.1`）。

## 发布节奏建议

- **PATCH**：关键 bug / 安全修复，随到随发
- **MINOR**：功能攒一波发，一两周一次
- 每次发版前确认 `package.json` 版本、git tag、镜像 tag 三者一致

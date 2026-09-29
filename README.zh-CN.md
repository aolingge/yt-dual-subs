<p align="center">
  <img src="icons/icon128.png" alt="YT Dual Subs 图标" width="72" />
</p>

<h1 align="center">YT Dual Subs · YouTube 双语字幕</h1>

<p align="center"><strong>把喜欢的视频，变成语言练习。</strong><br />
原文与译文同时看，陌生单词悬停查，难句反复听，实用表达收藏起来。</p>

<p align="center">
  <a href="https://github.com/aolingge/yt-dual-subs/archive/refs/heads/main.zip">下载最新源码</a> ·
  <a href="#安装">安装教程</a> ·
  <a href="README.md">English</a> ·
  <a href="https://github.com/aolingge/yt-dual-subs/issues">反馈问题</a>
</p>

<p align="center">
  <img alt="源码版本 3.9.1" src="https://img.shields.io/badge/source-3.9.1-3ea6ff" />
  <a href="LICENSE"><img alt="MIT 开源许可" src="https://img.shields.io/badge/license-MIT-36a886" /></a>
  <img alt="Chrome 和 Edge 桌面浏览器" src="https://img.shields.io/badge/browser-Chrome%20%7C%20Edge-5c6bc0" />
  <img alt="无需 API 密钥" src="https://img.shields.io/badge/API%20key-not%20required-777777" />
</p>

![德语原文与中文译文同时显示，字幕位于播放器控制栏上方](docs/images/bilingual-subtitles.png)

*图中是 3.8.1 实际扩展界面，使用插画场景与示例字幕。视频需要有可用的 YouTube 字幕，译文是否可得取决于翻译服务。*

## 看视频时，它能帮你做什么

| 你想做的事 | 扩展提供的功能 |
| --- | --- |
| 看懂外语视频 | 原文、译文在同一字幕框内分行显示。不限德语，英语、西班牙语、日语、阿拉伯语等字幕轨使用同一流程。 |
| 查一个不认识的词 | 鼠标停在原文单词上即可查译义；德语词还可点击进入**德语助手**详查。两行字幕都能拖选、复制。 |
| 练听力和跟读 | 先隐藏译文，需要时悬停或按键揭示；当前句可以降速、复读。 |
| 留住有用的表达 | 搜索视频字幕，按句跳转，收藏难句；复习时先遮住译文，再检查自己是否听懂。 |
| 调成舒服的字幕样式 | 拖动字幕框、拉伸左右边缘，分别设置字号、颜色和背景；小窗口与全屏自动适配。 |
| 带走学习材料 | 导出原文、译文或双语 SRT；收藏句子可用 JSON 备份、导入。 |

**免费使用 · 开源 · 无需注册扩展账号 · 无需 API 密钥。**

### 遇到生词，停一下鼠标就能查

鼠标在原文单词上停留约 0.4 秒，会出现译义卡片；移开后关闭。德语助手只在点击链接时打开。单词直译可能有歧义，仍需结合原句判断。

![悬停在 Spaziergang 上，显示单词译义及德语助手详查链接](docs/images/hover-word-lookup.png)

### 从“看过”到“练会”，只需几步

1. 在 YouTube 选择想学习的**原文字幕轨**，在扩展里选择译文目标语言。
2. 点击**使用学习预设**：保留原文、悬停显示译文，并以 0.75× 复读。
3. 使用**复读当前句、上一句、下一句**，把难句多听几遍。
4. 收藏值得记住的表达，复习时先不看译文，掌握后标记完成。

### 自动跟着播放高亮单词

在**学习**中开启**读到哪个词就框住哪个词**。整句原文一直完整显示，高亮跟随视频时间移动；拖动进度、暂停、更换视频后返回，也会按当前播放位置更新。扩展自动选择可用的时间来源：

| 视频提供的字幕数据 | 高亮方式 |
| --- | --- |
| 原字幕有逐词时间 | 直接跟随字幕词时间。 |
| 原字幕只有句子时间，同语言自动字幕有对应词时间 | 匹配附近且明确对应的词，补充时间，保留你选择的原文内容。 |
| 无法可靠匹配词时间 | 按句子时长显示**近似跟读**，画面明确标注。 |

近似跟读默认开启。如果只想使用字幕给出的词时间，关闭**无词时间时启用近似跟读**即可；无法匹配的句子仍完整显示。设置面板会显示当前句采用的时间来源。

在**学习 → 跟读高亮样式**中，可以分别调整高亮背景颜色、文字颜色和背景不透明度，并即时预览。默认使用 95% 不透明的金黄色背景与深色文字；调到 100% 后，视频不会透过高亮背景。

![中文跟读高亮设置：背景颜色、文字颜色及不透明度](docs/images/highlight-style-settings.png)

![明亮视频画面上的高对比度跟读高亮，德语整句保持完整显示](docs/images/high-contrast-subtitles.png)

*图中是 3.9.1 实际界面，使用受控字幕时间与演示视频，展示功能操作；没有测量与德语语音的实际对齐精度。*

各字幕语言都使用这套流程，无需为每个视频设置，也不要求 API 密钥。视频需要有可用字幕；自动字幕自身的词时间也可能有误差。近似跟读只是阅读辅助，不能代表精确朗读时间。扩展当前不识别音频，因此不能保证所有视频精确逐词跟随，也无法凭空生成缺失的字幕。

<table>
  <tr>
    <td align="center"><strong>逐句浏览、跳转与收藏</strong></td>
    <td align="center"><strong>按你的习惯调整布局</strong></td>
  </tr>
  <tr>
    <td><img src="docs/images/sentence-study.png" alt="实际扩展的逐句浏览界面，含德语原文轨与收藏句子" width="350" /></td>
    <td valign="top"><img src="docs/images/layout-settings.png" alt="实际扩展的字幕位置、宽度、间距与同步设置" width="350" /></td>
  </tr>
</table>

*设置界面支持中文、繁体中文和英文；上方的学习与布局截图使用英文界面。*

## 安装

支持 **Chrome、Microsoft Edge 桌面浏览器**。当前通过**加载已解压的扩展**安装。

1. [下载最新源码 ZIP](https://github.com/aolingge/yt-dual-subs/archive/refs/heads/main.zip)，解压到一个准备长期保留的文件夹。
2. Edge 打开 `edge://extensions`；Chrome 打开 `chrome://extensions`。
3. 开启**开发者模式**，点击**加载已解压的扩展程序**。
4. 选择解压后的 **yt-dual-subs-main** 文件夹，即包含 `manifest.json` 的那一层。
5. 打开一个有字幕的 YouTube 视频。扩展默认帮你开启 CC，也可在设置中关闭自动开启。
6. 将扩展固定到工具栏，打开弹窗，选择译文目标语言。

**更新时：**将新版文件覆盖到同一个扩展文件夹，在扩展管理页点击重新加载，然后**刷新已打开的 YouTube 标签页**。收藏句子保存在扩展本地；卸载前请[导出收藏备份](#隐私与数据)。

当前源码为 **3.9.1**，包含可调高对比度高亮、字幕自动恢复、翻译加速及设置合并保存。[最新发行包](https://github.com/aolingge/yt-dual-subs/releases/latest)仍为 **3.9.0**；要使用这些修复，请下载源码 ZIP 或使用 Git 克隆。可查看 [3.9.1 更新说明](docs/releases/v3.9.1.md#中文)。

浏览器官方教程：[Edge 本地加载扩展](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading) · [Chrome 加载已解压扩展](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)。

<details>
<summary>想直接使用源码？</summary>

```sh
git clone https://github.com/aolingge/yt-dual-subs.git
```

按上面的步骤加载克隆后的文件夹，无需构建或安装依赖。也可直接[下载源码 ZIP](https://github.com/aolingge/yt-dual-subs/archive/refs/heads/main.zip)。

</details>

## 想让译文更快出现

打开扩展弹窗 → **翻译 → 翻译引擎 → 快速显示**。

| 模式 | 工作方式 |
| --- | --- |
| **整句翻译**，默认 | 优先使用 YouTube 整轨译文；等待超过 0.35 秒后，使用 Google 准备当前句及后两句。 |
| **逐句翻译** | 通过 Google 逐句翻译。 |
| **快速显示** | 请求 YouTube 整轨译文的同时，立即用 Google 准备当前句及后两句。 |

原文可用时就先显示，不等待译文。完整字幕轨尚未加载时，**各模式**都可以先显示播放器已有的原文，并通过 Google 翻译。已加载的字幕按视频时间切换，迟到的译文会重新核对当前句；翻译服务的网络延迟和限流仍会影响到达时间。

扩展会复用播放器已经收到的完整字幕；短暂加载失败后会自动重试。备用原文逐词追加时，翻译请求会合并，已翻译的同句部分以 **…** 标示，随后补上最新译文。暂停等待也会继续加载翻译。

目标语言除了内置列表，还可选择**其他语言代码…**，输入 `nl`、`tr`、`uk` 或 `pt-BR` 等代码。插件并不限于德语；具体语种是否有译文，取决于字幕与服务支持。

## 常用操作与快捷键

| 操作 | 方法 |
| --- | --- |
| 显示 / 隐藏译文行 | `Alt+Shift+Y` |
| 复读当前句，再按一次停止 | `Alt+Shift+S` |
| 在“按键”模式中揭示译文 | `Alt+Shift+U` |
| 移动字幕框 | 拖左上角手柄；双击手柄恢复位置。 |
| 调整字幕框宽度 | 拖动左右侧手柄，或使用**布局 → 字幕框宽度**。双击侧手柄恢复自动宽度。 |
| 微调字幕同步 | **布局 → 字幕同步**，最多前后调整 2 秒；不改变 SRT 导出时间轴。 |
| 导出字幕 | **导出字幕**，选择原文、译文或双语。 |

快捷键可在 `edge://extensions/shortcuts` 或 `chrome://extensions/shortcuts` 修改。复读支持 **0.75×、0.6×、0.5×**，结束后恢复正常播放速度。

## 常见问题

<details>
<summary><strong>为什么字幕没有显示？</strong></summary>

先确认 YouTube 的 **CC / 设置 → 字幕** 菜单里有可用字幕轨。检查扩展已启用、字幕已开启，并刷新页面，尤其是刚更新过扩展时。弹窗顶部状态行会显示加载、备用模式或限流信息。视频没有字幕轨时，本扩展不能从音频生成字幕。

</details>

<details>
<summary><strong>原文出来了，译文还要等怎么办？</strong></summary>

选择**快速显示**，播放时会提前准备后续句子的译文。网络慢或翻译接口限流时仍可能等待，但原文不受这段等待影响；相同文本的重复翻译可使用缓存。

</details>

<details>
<summary><strong>能识别视频画面里自带的字幕吗？</strong></summary>

不能。扩展使用 YouTube 字幕数据或播放器原生字幕文本，不做 OCR、语音识别，也无法移除已经烧录进画面的字幕。

</details>

<details>
<summary><strong>调整颜色或滑块时，为什么报设置写入超额？</strong></summary>

旧代码每收到一次输入事件就写入浏览器同步存储。3.9.1 会先在本地保存并即时应用，再合并同步写入，两次同步至少间隔 2.5 秒；关闭弹窗也会保留最后的设置。遇到同步限流时，本地设置仍可使用，后台活动时会补存；跨设备同步取决于浏览器设置。更新后可清除扩展管理页中的历史错误，再观察是否出现新记录。

</details>

<details>
<summary><strong>“悬停查词”和“悬停显示译文”有什么区别？</strong></summary>

**查词**查询鼠标指向的单词。学习设置里的**译文显示 → 悬停**，则在鼠标进入播放器时显示整行译文，离开播放器或浏览器窗口时隐藏。两项功能可以分别设置。

</details>

<details>
<summary><strong>为什么双语 SRT 有时不能导出？</strong></summary>

双语和译文导出会检查口语句是否缺失、时间戳是否对齐。如果译文不完整，会提示问题，避免导出一个悄悄缺行的文件。已经加载原文字幕时，仍可导出原文 SRT。

</details>

## 隐私与数据

- 扩展不加入统计或追踪，不要求扩展账号。
- 翻译会将字幕文本发送到 YouTube 或 Google；悬停查词会向 Google 发送当前单词。Google 免费端点是非官方接口，可能被限流。
- 德语助手只在你点击词典链接后收到该词。
- 设置先暂存在本地，再写入浏览器扩展同步存储；**收藏句子仅存在本地，不会自动同步**。使用**导出收藏 / 导入收藏**备份和迁移，卸载扩展会清除本地数据。

查看[完整隐私与权限说明](docs/PRIVACY.md#中文)。

## 一起改进

遇到问题可[提交 Issue](https://github.com/aolingge/yt-dual-subs/issues)，说明浏览器与扩展版本、字幕语言、翻译模式和复现步骤。有帮助时可附公开视频链接，请勿上传个人信息。

欢迎参与改进。项目使用原生 JavaScript / CSS，无需构建。可查看[开发说明](docs/DEVELOPMENT.md)及 [3.9.1 更新说明](docs/releases/v3.9.1.md#中文)。如果它对你有用，欢迎点一个 Star，方便更多学习者找到它。

## 致谢与许可

本仓库基于 [Gythiro/yt-dual-subs](https://github.com/Gythiro/yt-dual-subs)，继续加入多语言学习、悬停查词、响应式布局、字幕框拉伸，以及启动速度和字幕同步方面的改进。保留原作者版权声明。

使用 [MIT 开源许可](LICENSE)。本项目独立开发维护，与 YouTube、Google、德语助手没有隶属关系。

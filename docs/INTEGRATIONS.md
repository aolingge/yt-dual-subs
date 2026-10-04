# Integration choices / 整合方案

The [2026-10-04 resource comparison](RESOURCE_REVIEW.md) covers recognition, alignment, translation and learning candidates plus the source-bridge improvements.

[2026-10-04 资源比较](RESOURCE_REVIEW.md)补充识别、对齐、翻译、学习工具候选及源码桥改进。

Primary-source review: 2026-10-04. This update uses existing project patterns and adds no third-party extension code or persistent service.

本次按官方资料核对（2026-10-04），复用项目现有结构，没有复制第三方扩展代码或添加常驻整合服务。

| Source / 来源 | Adopted approach / 本次采用 | Optional later / 可选后续 |
| --- | --- | --- |
| [Anki text import](https://docs.ankiweb.net/importing/text-files.html) | UTF-8 TSV, HTML escaping, stable first-field IDs and timestamp links. / UTF-8 TSV、安全 HTML 转义、首列稳定编号及时间链接。 | Actual installed-app import and optional AnkiConnect after user configuration. / 用户配置后可验证实际导入或使用 AnkiConnect。 |
| [asbplayer](https://github.com/asbplayer/asbplayer), [external API](https://docs.asbplayer.dev/docs/reference/external-api/) | Persistent transcript and optional sentence-end pause implemented using our existing timing logic. / 使用已有计时逻辑实现常驻字幕与可选句末暂停。 | Audio/screenshot mining needs a separately designed workflow; its proxy default 8766 conflicts with the current ASR bridge. / 音频与截图制卡需另行设计，其代理默认 8766 与当前 ASR 桥冲突。 |
| [Yomitan](https://yomitan.wiki/) | Transcript text is selectable; dictionary interaction can use normal user selection. No bundled dictionary or copied GPL code. / 字幕可选择，词典可使用普通文本选择；未打包词典或复制 GPL 代码。 | German dictionaries and actual scan behavior need verification with a user-selected dictionary. / 德语词典及实际取词效果需按用户选择验证。 |
| [Cloud Translation API](https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate) | Keep the existing free endpoint, adding shared limits and cooldown; clearly describe its unofficial status. / 保留现有免费接口，加统一限流和冷却，并明确非官方性质。 | Official Google API needs credentials/billing; [LibreTranslate](https://docs.libretranslate.com/guides/api_usage/) needs a configured endpoint/service. Neither is activated here. / 官方 Google API 需要凭据或计费，LibreTranslate 需要配置服务地址，本次均未启用。 |

## Platform guidance / 浏览器依据

[Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage) documents that local storage is exposed to content scripts by default. [Extension storage origins](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) support moving credentials to extension-origin IndexedDB while retaining restart persistence. [Messaging security](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations) supports validating privileged requests. [Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen) and [tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) guide the capture lifecycle and Chromium 116 minimum.

Chrome 文档说明 `storage.local` 默认可供内容脚本访问，因此令牌改用扩展自身来源的 IndexedDB，同时保留重启后的持久性。消息权限、离屏文档生命周期及 Chromium 116 最低版本按上述官方文档处理。此存储方案不额外加密浏览器资料目录。

# Anki export

In **Saved review**, choose **Export to Anki (TSV)**. The UTF-8 file contains
`CardId`, `Original`, `Translation`, `Title`, `VideoId`, `TimeSeconds`, `URL`,
`SourceLanguage`, and `Tags`. YouTube links seek to the saved second; Bilibili
links also retain the part. Missing translations stay empty.

Import the file in desktop Anki, choose your note type and deck, and verify the
preview. The header declares tabs, HTML, named columns and the ninth column as
tags. Use the stable `CardId` to update matching notes on repeated exports.
Literal HTML is escaped, line breaks become `<br>`, and duplicate saved entries
are exported once. JSON remains the extension backup format. The fixture file
and browser download are tested; importing into an installed Anki app is not
verified here. See [Anki's text-file import documentation](https://docs.ankiweb.net/importing/text-files.html).

## 中文

在 **收藏复习** 中点击 **导出到 Anki（TSV）**。UTF-8 文件包含卡片编号、原文、译文、
标题、视频编号、秒数、时间链接、原文语言和标签。B 站链接保留分 P；缺失译文为空。

建议复制 Anki 的“基础”笔记类型并命名 `YT Dual Subs`，按顺序建立八个字段：
`CardId`、`Original`、`Translation`、`Title`、`VideoId`、`TimeSeconds`、`URL`、`SourceLanguage`。
`CardId` 保持第一位用于去重，第九列自动导入为标签。正面模板使用 `{{Original}}`，
背面模板使用：

```html
{{FrontSide}}<hr id="answer">{{Translation}}<br>{{Title}}<br><a href="{{URL}}">▶</a>
```

在电脑版 Anki 中导入文件，选择笔记类型和牌组并核对预览。文件头已声明制表符、HTML、
字段名称和第九列为标签。重复导出时使用稳定的 `CardId` 更新已有笔记。特殊字符安全转义，
换行保留为 `<br>`，重复收藏只导出一次。JSON 仍是扩展内恢复收藏的备份格式；已验证文件
下载，但尚未在本机 Anki 应用内实际导入。

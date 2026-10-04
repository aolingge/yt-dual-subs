# YT Dual Subs project instructions

## Quiet browser testing

- Run browser checks in a separate profile. Every test browser must start with
  `--mute-audio` by default, including headless and session-recovery runs.
- Keep media decoding, playback and captured input available for subtitle timing
  and recognition checks; silence the test browser's speaker output.
- Do not mute the operating system, change its master volume, or change audio
  settings in the user's normal browser.
- Enable audible output only when the user explicitly requests that particular
  audio check. The existing opt-ins are `YTDS_TEST_AUDIO=1` for the Node runners
  and `-AllowTestAudio` for `tools/Start-EdgeRecovery.ps1`.
- Verify the isolated browser's actual launch flags and existing playback checks;
  report separately if end-to-end capture or acoustic silence was not measured.

浏览器测试默认使用独立配置并加 `--mute-audio`，包括无界面及会话恢复测试。
保留解码、播放和音频采集能力，只关闭测试浏览器的扬声器输出。
不得调整系统总音量或用户日常浏览器；仅在用户明确要求该项有声验证时开启声音。

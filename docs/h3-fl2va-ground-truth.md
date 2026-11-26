# H3 FL2VA 适配器 · 真图底稿（生产实证）

来源：2026-11-25 青蛙帽复刻段 A 的生产工作流 `~/workspace/douyin-dance-account/ref-froghat/work/wf_fh_vid1.json`——经 Tailscale 直连提交真机 ComfyUI 8188 跑通、成片已交付的原图。段 B（wf_fh_vid2.json）同图，仅 length/seed/prefix 不同。写 `h3-fl2va` 适配器时按此图组装，不要凭记忆猜节点。

## 节点链

| id | class_type | 关键输入 |
|---|---|---|
| unet | UNETLoader | unet_name=`minimax_h3_fl2va_pruned_int8_convrot.safetensors`（适配器取模型记录 file_name）、weight_dtype=default |
| clip | CLIPLoader | clip_name=`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`、type=`minimax`、device=default |
| vae | VAELoader | vae_name=`minimax_h3_video_vae_fp16.safetensors` |
| avae | VAELoader | vae_name=`minimax_h3_audio_vae_fp32.safetensors`（原图里存在；i2v 节点未直接消费，组装时保留与否按真机校验定） |
| img | LoadImage | image=首帧文件名（ComfyUI input 内） |
| i2v | MiniMaxH3ImageToVideo | clip←clip、vae←vae、first_frame←img、prompt、width、height、length（帧数）；输出 [0]=conditioning、[1]=latent |
| shift | MiniMaxH3SigmaShift | model←unet、shift_audio=3、shift_video=12 |
| sigmas | BasicScheduler | model←shift、scheduler=`simple`、steps=20、denoise=1 |
| sampler | KSamplerSelect | sampler_name=`res_multistep` |
| noise | RandomNoise | noise_seed=种子 |
| guider | BasicGuider | model←shift、conditioning←i2v[0] |
| sample | SamplerCustomAdvanced | noise、guider、sampler、sigmas、latent_image←i2v[1] |
| decode | VAEDecode | samples←sample、vae←vae |
| video | CreateVideo | images←decode、fps=24 |
| save | SaveVideo | video←video、filename_prefix、format=auto、codec=auto |

## 与现有代码的衔接点

- 底模回读：mp4 元数据回读尚未实现（已知未完成项）——FL2VA 适配器落地时一并补：从 mp4 里嵌的 prompt JSON 取 UNETLoader 的 unet_name 与预期比对。
- 帧数：length 走现有 17k+5 吸附；width/height 走 32 倍数（竖屏 720p=736×1280）。
- 排期口径（2026-11-25 硬实测）：20 步 FL2VA 单帧耗时随单段帧数涨——73 帧≈11.9 秒/帧、175 帧≈16.8、294 帧≈23.5；UI 或日志里给耗时预期时按段长估。
- Ref2VA 变体：底模换 `minimax_h3_ref2va_pruned_int8_convrot.safetensors`，条件节点与参考素材输入不同，写适配器时另从短剧线生产工作流提取底稿，不要从 FL2VA 图臆改。

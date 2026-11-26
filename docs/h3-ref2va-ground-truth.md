# H3 Ref2VA 适配器 · 真图底稿（生产实证）

来源：短剧线《临安夜巡》的生产工作流原件（VM 侧留存）——`~/workspace/linan-shots/linan_s1.json`、linan_s3–s7.json 与 `~/workspace/linan-s2/linan_s2_jia.json`、linan_s2_yi.json，共 8 张 Ref2VA 图，参数口径全一致（赵砚/沈清禾线，验证样片 v2 已通过）。副证：`~/workspace/reports/merge-smoke/smoke_ref2va.json`（单实例整合冒烟图，含参考音频有声变体）。节点 spec 已于 2026-11-26 经 Tailscale 隧道 GET 8188 `/object_info` 逐项核对：`MiniMaxH3ReferenceToVideo` 的 input spec 与生产图吻合，UNETLoader 枚举确认 `minimax_h3_ref2va_pruned_int8_convrot.safetensors` 在列。写 `h3-ref2va` 适配器时按此图组装，不要从 FL2VA 图臆改——两者的条件节点、参考素材形态、音频支路都不同。

注：本次取证时 Mac 设备通道 files.search 在准备会话不可用，未能再翻 Mac 侧 .reelbench 产物树；但 VM 留存的生产图原件已构成完整实证链（8 图互证＋冒烟图＋object_info 三方对齐），不缺项。ComfyUI 当前 /history 仅剩 4 条（整合换实例后旧历史已清），帮不上忙属正常。

## 节点链（基准图 linan_s1，17 节点；有声变体 18 节点）

| id | class_type | 关键输入 |
|---|---|---|
| unet | UNETLoader | unet_name=`minimax_h3_ref2va_pruned_int8_convrot.safetensors`（适配器取模型记录 file_name）、weight_dtype=default |
| clip | CLIPLoader | clip_name=`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`、type=`minimax`、device=default |
| vae | VAELoader | vae_name=`minimax_h3_video_vae_fp16.safetensors` |
| avae | VAELoader | vae_name=`minimax_h3_audio_vae_fp32.safetensors`（**与 FL2VA 图不同：这里被条件节点的 audio_vae 真实消费，必备，不是闲置**） |
| ref0…refN | LoadImage | image=参考图文件名（ComfyUI input 内）；生产实证：角色脸、角色全身、第二角色全身、场景图 |
| voice0 | LoadAudio | audio=参考音频文件名（可选；生产实证为角色定版录音 wav，如 `linan_zy_voice.wav`） |
| r2v | MiniMaxH3ReferenceToVideo | clip←clip、vae←vae、audio_vae←avae、prompt（见下方标签规范）、width、height、length、`ref_image_size=match`、`ref_images.ref_image_0…`←各 LoadImage、`ref_audios.ref_audio_0`←LoadAudio（可选）；输出 [0]=conditioning、[1]=latent（与 FL2VA 的 i2v 节点同构，下游可原样复用） |
| shift | MiniMaxH3SigmaShift | model←unet、shift_audio=3、shift_video=12（生产图、FL2VA 图、object_info 默认值三方一致） |
| sigmas | BasicScheduler | model←shift、scheduler=`simple`、steps=20、denoise=1 |
| sampler | KSamplerSelect | sampler_name=`res_multistep` |
| noise | RandomNoise | noise_seed=种子 |
| guider | BasicGuider | model←shift、conditioning←r2v[0] |
| sample | SamplerCustomAdvanced | noise、guider、sampler、sigmas、latent_image←r2v[1] |
| decode | VAEDecode | samples←sample、vae←vae |
| decodeA | VAEDecodeAudio | **仅有声变体**：samples←sample、vae←avae |
| video | CreateVideo | images←decode、fps=24；有声变体另加 audio←decodeA |
| save | SaveVideo | video←video、filename_prefix、format=auto、codec=auto |

## 参考素材形态（object_info spec 与生产用量）

| 通道 | 节点输入名（autogrow） | spec 上限 | 生产实证用量 | 素材来源节点 | prompt 标签 |
|---|---|---|---|---|---|
| 参考图 | `ref_images.ref_image_N` | 9 | **1–4 路**（s5 只用 1 路，s7 用满 4 路） | LoadImage（IMAGE） | `<Picture N>`，N 从 1 起、按 ref_image_0… 顺序 |
| 参考视频 | `ref_videos.ref_video_N` | 3 | **0——8 张生产图从未用过** | IMAGE 帧批（VHS_LoadVideo / GetVideoComponents），24fps、2–15s | `<Video K>` |
| 参考视频音轨 | `ref_video_audios.ref_video_audio_N` | 3 | **0——从未用过** | AUDIO，与同号参考视频配对 | （随 `<Video K>`） |
| 参考音频 | `ref_audios.ref_audio_N` | 3 | **0–1 路**（角色定版录音） | LoadAudio（AUDIO） | `<Audio J>`，J 从 1 起 |

- prompt 规范（生产实证）：开头先逐个定义主体——`Subject definitions: <Picture 1> shows the face of …`，正文再用标签引用角色/场景/声音；无声镜在 prompt 里明写完全静默，有声镜引用 `<Audio 1>`。提示词卫生沿用短剧线口径：全英文、仅台词行可带 [Chinese]（H3 卫生规矩不变）。
- `ref_image_size`：生产 8 图全用 `match`（按生成像素面积缩放参考图、只缩不放）。spec 另有 `max`（2048px 短边、身份保真最好但慢数倍），生产未用过。

## 生产参数口径（8 图全一致）

- 736×1280（竖屏 720p）、20 步、simple、res_multistep、SigmaShift 3/12、ref_image_size=match、CreateVideo 24fps。
- **length 未按 17k+5 吸附**：生产值为 53 / 56 / 65 / 77（短剧短镜），与 FL2VA 的吸附口径不同；且低于节点 tooltip 标注的 trained range（约 124–362），短镜实测可用（样片 v2 已过）。适配器是透传还是吸附，见待校验清单第 2 条。
- 有声/无声是图的二分支：挂了 ref_audio 才有 decodeA 与 CreateVideo.audio（s3、s7、s2_jia、冒烟图有；其余无）。组装时按「是否带参考音频」分支，别把 avae 当闲置删掉、也别无声镜硬塞音频支路。

## 与现有代码的衔接点（只列计划，写适配器时照此办）

- 适配器名建议 `h3-ref2va`，在 `buildComfyWorkflow` 加分发；`ADAPTER_DEFAULTS['h3-ref2va']`＝{ steps: 20, sampler: 'res_multistep', scheduler: 'simple' }（与 h3-fl2va 相同）。下游采样/解码/存片链与 FL2VA 完全同构，可复用同一套组装骨架，只换条件节点段。
- 模型记录：file_name=`minimax_h3_ref2va_pruned_int8_convrot.safetensors`。capability 建议新增取值 `reference-to-video`（现有枚举只有 text-to-image / image-to-image / text-to-video / image-to-video，`SettingsView` 的 CAPABILITIES 与三语词典 `cap.*` 键要同步加）；若先复用 `text-to-video` 糊弄，前端筛选会与真文生视频模型混排，不推荐。
- 分段素材槽：需新增**参考图槽（多路）**——上限先按生产实证做 4 路、硬顶 9（spec 上限）；**参考音频槽 0–1 路**（硬顶 3）。参考视频槽先不做（无生产实证，见待校验第 1 条）。这与 FL2VA 的 first_frame/last_frame 单槽模型不同，db 侧大概率要一张参考素材子表或 JSON 列，写适配器时一并设计。
- 上传链路：复用 FL2VA 的严格上传模式（api.ts 的 `uploadFrameToComfy`）——每路参考图/音频在提交前逐个严格上传到 ComfyUI input，**任一失败任务直接落 failed，绝不静默少挂**：Ref2VA 的身份一致性全靠参考素材，少挂一路出的是「能跑但人不对」的片，比报错更坏。上传成功后把 ComfyUI 侧文件名回写任务快照（同 FL2VA 口径）。
- 任务 settings 需带：参考图文件名数组（顺序即 `<Picture N>` 编号，顺序不可乱）、参考音频文件名（可空）、ref_image_size（默认 match）。prompt 里的标签编号与素材顺序的对应关系由组装层保证，前端编辑 prompt 时应提示当前编号对照。
- 底模回读：mp4 元数据回读已随 FL2VA 落地实现，Ref2VA 产物同为 SaveVideo 的 mp4，直接复用，无新增工作。
- 排期口径：暂按 FL2VA 的帧数-耗时曲线估（同为 20 步 H3 视频采样），但参考图走 `match` 时参考 token 贯穿每步采样，实际可能更慢；真机首跑后按 /history 硬时间戳校准（计时禁令：不许拿等待时长凑数）。

## 待真机校验清单（写适配器后、进生产前逐项过）

1. **参考视频两路（ref_videos / ref_video_audios）零生产实证**：只有 object_info spec。真要用，先单跑一条冒烟确认帧批格式（VHS_LoadVideo 的 IMAGE 输出直连即可？还是要 GetVideoComponents 拆 VIDEO）与音轨配对编号。
2. **length 吸附口径二选一**：生产图透传（53–77 帧短镜）；AUTEUR 现有 FL2VA 走 17k+5 吸附。Ref2VA 适配器定口径前，两种各跑一条同 prompt 对照，确认短帧数在当前 0.45 实例上不崩（生产图是整合前旧实例跑的，整合后 Ref2VA 尚未复跑过）。
3. **参考音频上传端点**：图片走 /upload/image 已实证；音频文件落 ComfyUI input 走哪个端点（ComfyUI 的 /upload/image 对非图文件是否照收）未验，联调时先试、失败再查 /object_info 外的上传路由。
4. **ref_image_size=max 档**：速度代价与身份保真增益未测，短剧线若嫌 match 档脸漂再单测，不要默认开。
5. **别误用 Director 节点**：object_info 里另有 `MiniMaxH3DirectorGroupReferenceToVideo`，那是工作台侧的分组辅助节点（输出 MMX_DIR_GROUP、给 Director 工具读的），不是条件节点本体；AUTEUR 组装只用 `MiniMaxH3ReferenceToVideo`。

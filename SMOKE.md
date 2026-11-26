# AUTEUR · 端到端冒烟记录

日期：2026-11-26
环境：VM（Linux，Node v24.22.1），`npm run build` 后运行 `node scripts/smoke.mjs`
结果：**82/82 全部通过**（本轮 h3-ref2va 适配器新增 21 项；此前三轮 61/61、41/41、30/30）。

## 冒烟方式

- 桩：`tools/stub-comfyui.mjs`（端口 18188），实现 `/object_info`、`/prompt`、
  `/queue`、`/history/:id`、`/view`、`/upload/image`、队列删除与 `/interrupt`，
  另有桩专用调试口 `/__uploads`（回读已上传到 ComfyUI input 的文件名列表）；
  任务按 pending →（0.6s）running →（2.5s）done 流转。产物按工作流类型分流：
  图像工作流（SaveImage）产 PNG（带 `prompt` tEXt 元数据）；视频工作流
  （SaveVideo/CreateVideo）产 MP4，工作流 JSON 以 QuickTime 元数据格式写进
  moov/udta/meta 的 keys+ilst「prompt」项——两者都与真 ComfyUI 同格式。
  桩支持探针：工作流文本含 `auteur-mismatch-probe` 时，嵌入元数据里的 UNET 名
  会被换成 `some_other_model.safetensors`，用来触发「不一致」分支。
- 被测服务：真实 AUTEUR 服务（`server/dist/index.js`，端口 14377），
  数据目录隔离在临时目录（`AUTEUR_DATA_DIR=/tmp/auteur-smoke-*`），未触碰真实数据。
- 前端：`web/dist` 构建产物由服务同端口托管，冒烟校验了首页 HTML。

## 通过项（82）

1. 服务启动且 `/api/health` 可达
2. 建项目 / 建分镜 / 建分段
3. 建 ComfyUI 渠道；连接测试通过（桩返回 5 个节点）
4. 经 `/object_info` 发现模型（UNET 3 个，含 `stub_h3_fl2va.safetensors`）
5. 渠道模型文件集保存成功
6. 建模型、建项目级 video 路由
7. 外部 API 渠道：Key 只存本地，读回为掩码（`sk-••••••7890`），响应中无明文
8. **label 硬规则**：空白 label 提交被拒（HTTP 400）
9. 经路由提交任务，拿到 prompt_id
10. **帧数吸附**：提交 120 帧 → 快照 124 帧（17k+5 网格），adjustments 有记录
11. 轮询 `/queue` + `/history` 后任务置完成
12. 产物登记为 take（`stub_<id>_00001.png`）
13. **底模回读**：从 PNG 元数据读出真实 UNET = `stub_h3_fl2va.safetensors`
14. take 标记为「底模已验证 ✓」；产物经 `/media` 可访问（image/png）
15. 已验证 take 可直接选用；分段状态变为「已选用」
16. 不一致探针：任务完成但 take 标记 `mismatch`（回读 `some_other_model.safetensors`），
    未确认选用被拒（HTTP 409）
17. 取消语义：排队任务可取消；已完成任务取消被拒（HTTP 400）
18. 停止语义：运行中任务可停止 → 状态经 `stopping` 对账落定为 `stopped`，无卡死
19. 构建后的前端在 `/` 正常返回（含 root 节点与 AUTEUR 标题）
20. **h3-image 适配器**（MiniMax H3-Image 真生产链）：
    - 建模型（adapter=`h3-image`、file_name=真 UNET 名）时 `seedream_lora` 参数自动默认关
    - 提交图像任务，快照带适配器默认值（6 步 / CFG 1 / euler / simple），无需分段预设
    - 任务完成，take 回读 UNET = `minimax_h3_image_pruned_bf16.safetensors` 与预期一致 → 已验证
    - 从产物 PNG 元数据解出所提交工作流并断言结构：UNETLoader（unet_name=真名）、
      CLIPLoader（type=`minimax`、clip_name=真 TE 名）、VAELoader（真 VAE 名）、
      EmptyLatentImage、KSampler（默认值与 model/positive/negative/latent 连线正确，
      负向为空文本 CLIPTextEncode）、VAEDecode → SaveImage 连线正确；
      seedream 关时无 LoraLoaderModelOnly 节点
    - seedream 开的第二条任务：快照标记 `seedream_lora=true`；工作流中
      LoraLoaderModelOnly（`Seedreamstyle_H3_Resume_6K.safetensors`、强度 1.0）串入
      UNET→KSampler 模型链，正向提示词首带 `seedreamstyle. ` 触发词
21. **h3-fl2va 适配器**（MiniMax H3 首尾帧视频真生产链，底稿
    `docs/h3-fl2va-ground-truth.md`，源自青蛙帽复刻段 A 的生产工作流）：
    - **首帧硬规则**：分段无首帧时提交被拒（HTTP 400）；首帧文件在媒体库里
      读不到时任务落 `failed` 并带明确错误（HTTP 502），绝不无首帧出片
    - 提交前首帧经 `/upload/image` 真上传到 ComfyUI input（桩 `/__uploads` 实证），
      快照记下 ComfyUI 侧文件名；帧数 120 → 124（17k+5），快照带适配器默认值
      （20 步 / res_multistep / simple）
    - 任务完成，take 登记为 video（mp4）；**从 MP4 元数据回读** UNET =
      `minimax_h3_fl2va_pruned_int8_convrot.safetensors` 与预期一致 → 已验证
    - 从产物 MP4 元数据解出所提交工作流，逐项对底稿断言：15 个节点齐全
      （UNETLoader / CLIPLoader(minimax) / 视频+音频双 VAELoader / LoadImage /
      MiniMaxH3ImageToVideo / MiniMaxH3SigmaShift / BasicScheduler /
      KSamplerSelect / RandomNoise / BasicGuider / SamplerCustomAdvanced /
      VAEDecode / CreateVideo / SaveVideo）；SigmaShift 音频 3 / 视频 12、
      BasicScheduler simple 20 步、KSamplerSelect res_multistep、guider 与
      latent（i2v 输出 0/1）连线、CreateVideo 24fps、SaveVideo auto/auto 全对
    - 尾帧可选：分段设尾帧后第二条任务的工作流多出 LoadImage 并连到
      `i2v.last_frame`，take 同样回读已验证（分段表新增 `last_frame` 列，
      存量库启动时自动迁移）
    - **真机样本**：青蛙帽段 A 的真 ComfyUI 原始产物 `fh_s1.mp4` 喂给服务端
      回读器，正确解出其 UNET 名（结构化解析 moov/udta/meta keys+ilst，
      非字节碰运气）
22. **h3-ref2va 适配器**（MiniMax H3 参考生视频真生产链，底稿
    `docs/h3-ref2va-ground-truth.md`，源自《临安夜巡》8 张生产工作流原件）：
    - **参考图硬规则**：分段无参考图时提交被拒（HTTP 400）；某张参考图文件
      在媒体库里读不到时任务落 `failed` 并带明确错误（HTTP 502），绝不少图出片
    - 分段新增 `ref_images`（JSON 数组，顺序即 `<Picture N>` 编号）与
      `ref_audio` 两列，存量库启动时自动迁移；API 读回为数组
    - 提交前每张参考图逐张经 `/upload/image` 严格上传到 ComfyUI input
      （桩 `/__uploads` 实证），快照按顺序记下 ComfyUI 侧文件名清单；
      快照带适配器默认值（20 步 / res_multistep / simple）与 `ref_image_size=match`
    - 任务完成，take 登记为 video（mp4）；从 MP4 元数据回读 UNET =
      `minimax_h3_ref2va_pruned_int8_convrot.safetensors` 与预期一致 → 已验证
    - 从产物 MP4 元数据解出所提交工作流，逐项对底稿断言（无声变体 16 节点）：
      UNETLoader（真名）/ CLIPLoader(minimax) / 视频+音频双 VAELoader（音频
      VAE 被 r2v 的 audio_vae 真实消费）/ 2×LoadImage /
      MiniMaxH3ReferenceToVideo（`ref_images.ref_image_0/1` 按序连线、
      ref_image_size=match、宽高/帧数、prompt 原文含 `<Picture N>` 标签逐字保留）/
      SigmaShift 3/12 / BasicScheduler simple 20 步 / res_multistep /
      guider 与 latent（r2v 输出 0/1）连线 / VAEDecode → CreateVideo 24fps →
      SaveVideo；无声变体断言无 LoadAudio、无 VAEDecodeAudio、
      CreateVideo 无 audio 输入
    - **参考音频变体**：分段挂参考音频（`.wav` 经 `/api/uploads` 入媒体库）
      后第二条任务——音频提交前同样严格上传（桩实证），快照记下音频名；
      工作流多出 LoadAudio（连 `ref_audios.ref_audio_0`）与 VAEDecodeAudio
      （连 CreateVideo.audio），共 18 节点；take 同样回读已验证。
      注：音频在桩上走 `/upload/image` 通道，真机 ComfyUI 是否收非图文件
      未验（底稿待校验清单第 3 条），联调时单独验，失败会以明确错误冒出

## 桩与替身清单

- ComfyUI 本体是桩（见上），未连真机；桥地址为渠道配置项，日后把渠道 base URL
  指向 `http://192.168.1.10:8188` 即可联调真 ComfyUI。
- 外部 OpenAI 兼容渠道只验了配置与 Key 掩码，未真发图（桩无外部 API 替身；
  代码路径已实现，见 server/src/adapters.ts `submitOpenAIImage`）。

## 本轮未完成 / 已知限制

- 元数据回读已覆盖 PNG（tEXt/zTXt/iTXt）与 MP4/MOV（QuickTime meta
  keys+ilst 结构化解析，兜底字节扫描），纯自包含、无外部 ffprobe 依赖；
  webm 仍未覆盖，此类 take 标「未验证」。注意：经 ffmpeg 后期再封装的成片
  （如青蛙帽装配版）元数据已被洗掉，回读为未验证属预期——take 登记的是
  ComfyUI 原始产物，不受影响。
- ComfyUI 适配器：comfy-video / comfy-image 仍组装通用 loader→sampler→save
  工作流；h3-image、h3-fl2va、h3-ref2va 已按真生产链组装。Ref2VA 的
  length 仍走全局 17k+5 吸附（生产图为 53–77 帧透传短镜，口径二选一
  待真机对照，见底稿待校验清单第 2 条）；参考视频两路
  （ref_videos / ref_video_audios）零生产实证，未接入。
- 首帧/参考素材上传：h3-fl2va、h3-ref2va 走严格上传（失败即任务失败并
  给错误）；其余适配器仍为尽力而为（`/upload/image` 失败不阻塞提交）。
- Tauri 仅目录占位与说明（src-tauri/README.md），未真打包。
- 前端为功能优先的深色工作台风，未做视觉精修；分段拖拽排序、角色锚图的
  版本/用途编辑等细节未做（数据字段已预留）。

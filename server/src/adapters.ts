/**
 * Adapters translate the unified segment settings into channel-specific
 * requests. Phase 1 ships five: comfy-video (UNET based), comfy-image
 * (checkpoint based), h3-image (MiniMax H3-Image production workflow),
 * h3-fl2va (MiniMax H3 first/last-frame video production workflow),
 * h3-ref2va (MiniMax H3 reference-to-video production workflow) and
 * openai-image (OpenAI-compatible image API).
 */

export interface GenSettings {
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  cfg: number;
  seed: number;
  sampler: string;
  scheduler: string;
  prompt: string;
  firstFrameName: string | null; // file name inside ComfyUI input dir, if any
  lastFrameName?: string | null; // h3-fl2va only: optional last frame, same convention
  refImageNames?: string[]; // h3-ref2va only: reference image names in ComfyUI input, order = <Picture N>
  refAudioName?: string | null; // h3-ref2va only: optional reference audio name in ComfyUI input
  refImageSize?: string; // h3-ref2va only: 'match' (production default) or 'max'
  seedreamLora?: boolean; // h3-image only: attach the Seedreamstyle LoRA
}

/**
 * Per-adapter fallback settings, applied when neither the job overrides nor
 * the segment carry a value (see the job route in api.ts).
 */
export const ADAPTER_DEFAULTS: Record<string, { steps?: number; cfg?: number; sampler?: string; scheduler?: string }> = {
  'h3-image': { steps: 6, cfg: 1, sampler: 'euler', scheduler: 'simple' },
  // FL2VA samples through SamplerCustomAdvanced: steps/scheduler land on the
  // BasicScheduler node, the sampler name on KSamplerSelect (res_multistep).
  'h3-fl2va': { steps: 20, sampler: 'res_multistep', scheduler: 'simple' },
  // Ref2VA samples through the same SamplerCustomAdvanced chain as FL2VA.
  'h3-ref2va': { steps: 20, sampler: 'res_multistep', scheduler: 'simple' },
};

/** Model-level params a model record starts with for a given adapter. */
export function adapterParamDefaults(adapter: string): Record<string, any> {
  if (adapter === 'h3-image') return { seedream_lora: false };
  return {};
}

/** Video frame counts must sit on the 17k+5 grid (22, 39, 56, 73, 90, 124...). */
export function snapFrames(frames: number): { frames: number; snapped: boolean } {
  if (!Number.isFinite(frames) || frames <= 22) return { frames: 22, snapped: frames !== 22 };
  let best = 22;
  for (let k = 1; 17 * k + 5 <= frames + 17; k++) {
    const candidate = 17 * k + 5;
    if (Math.abs(candidate - frames) < Math.abs(best - frames)) best = candidate;
  }
  return { frames: best, snapped: best !== frames };
}

export function isOnFrameGrid(frames: number): boolean {
  return frames >= 22 && (frames - 5) % 17 === 0;
}

export function snapTo32(value: number): { value: number; snapped: boolean } {
  const snappedValue = Math.max(32, Math.round(value / 32) * 32);
  return { value: snappedValue, snapped: snappedValue !== value };
}

export function secondsToFrames(seconds: number, fps: number): number {
  return snapFrames(Math.round(seconds * fps)).frames;
}

/**
 * Generic ComfyUI workflow assembly. Node wiring follows the common
 * loader -> encode -> latent -> sampler -> save shape; per-model production
 * workflows can replace this adapter later without touching the bridge.
 */
/* ------------------------- MiniMax H3-Image --------------------------- */

/**
 * Fixed companion files for the H3-Image production chain (verified against
 * the production ComfyUI /object_info). The UNET itself is NOT fixed here:
 * it comes from the model record's file_name so base-model read-back
 * verification compares against exactly what the user configured.
 */
export const H3_IMAGE = {
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  clipType: 'minimax',
  vae: 'minimax_h3_image_vae_fp16.safetensors',
  seedreamLora: 'Seedreamstyle_H3_Resume_6K.safetensors',
  seedreamTrigger: 'seedreamstyle. ',
  seedreamStrength: 1.0,
} as const;

/**
 * H3-Image workflow: UNETLoader (-> optional LoraLoaderModelOnly) feeds the
 * KSampler model input; a dedicated CLIPLoader (type minimax) feeds two
 * CLIPTextEncode nodes — the prompt, and an empty-text negative (at CFG 1
 * the negative is effectively inert, but KSampler requires the input);
 * VAELoader -> VAEDecode -> SaveImage.
 */
export function buildH3ImageWorkflow(modelFile: string, s: GenSettings, prefix: string): Record<string, any> {
  const useLora = Boolean(s.seedreamLora);
  const prompt = useLora && !s.prompt.startsWith(H3_IMAGE.seedreamTrigger)
    ? H3_IMAGE.seedreamTrigger + s.prompt
    : s.prompt;
  const workflow: Record<string, any> = {};
  workflow['1'] = { class_type: 'UNETLoader', inputs: { unet_name: modelFile, weight_dtype: 'default' } };
  let modelRef: [string, number] = ['1', 0];
  if (useLora) {
    workflow['2'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { lora_name: H3_IMAGE.seedreamLora, strength_model: H3_IMAGE.seedreamStrength, model: ['1', 0] },
    };
    modelRef = ['2', 0];
  }
  workflow['3'] = { class_type: 'CLIPLoader', inputs: { clip_name: H3_IMAGE.clip, type: H3_IMAGE.clipType } };
  workflow['4'] = { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['3', 0] } };
  workflow['5'] = { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['3', 0] } };
  workflow['6'] = { class_type: 'EmptyLatentImage', inputs: { width: s.width, height: s.height, batch_size: 1 } };
  workflow['7'] = { class_type: 'VAELoader', inputs: { vae_name: H3_IMAGE.vae } };
  workflow['8'] = {
    class_type: 'KSampler',
    inputs: {
      seed: s.seed,
      steps: s.steps,
      cfg: s.cfg,
      sampler_name: s.sampler,
      scheduler: s.scheduler,
      denoise: 1,
      model: modelRef,
      positive: ['4', 0],
      negative: ['5', 0],
      latent_image: ['6', 0],
    },
  };
  workflow['9'] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['7', 0] } };
  workflow['10'] = { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['9', 0] } };
  return workflow;
}

/* --------------------- MiniMax H3 FL2VA (video) ------------------------ */

/**
 * Fixed companion files / parameters for the H3 FL2VA production chain,
 * taken from the verified production workflow (see
 * docs/h3-fl2va-ground-truth.md — the frog-hat segment-A graph that ran on
 * the real ComfyUI and shipped). The UNET itself is NOT fixed here: it comes
 * from the model record's file_name so base-model read-back verification
 * compares against exactly what the user configured.
 */
export const H3_FL2VA = {
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  clipType: 'minimax',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  shiftAudio: 3,
  shiftVideo: 12,
  sampler: 'res_multistep',
} as const;

/**
 * H3 FL2VA workflow (node ids mirror the production graph):
 * UNETLoader -> MiniMaxH3SigmaShift (audio 3 / video 12) -> BasicScheduler
 * (simple, 20 steps) + KSamplerSelect (res_multistep) + RandomNoise feed
 * SamplerCustomAdvanced via BasicGuider; conditioning and latent come from
 * MiniMaxH3ImageToVideo (CLIP + video VAE + first frame [+ optional last
 * frame]); VAEDecode -> CreateVideo (fps from settings) -> SaveVideo.
 *
 * A first frame is mandatory: callers must have uploaded it into ComfyUI's
 * input dir and passed its name as settings.firstFrameName. Building a
 * workflow without one is a hard error, never a silent text-to-video.
 */
export function buildH3Fl2vaWorkflow(modelFile: string, s: GenSettings, prefix: string): Record<string, any> {
  if (!s.firstFrameName) {
    throw new Error('h3-fl2va requires a first frame (settings.firstFrameName is empty)');
  }
  const wf: Record<string, any> = {};
  wf['unet'] = { class_type: 'UNETLoader', inputs: { unet_name: modelFile, weight_dtype: 'default' } };
  wf['clip'] = { class_type: 'CLIPLoader', inputs: { clip_name: H3_FL2VA.clip, type: H3_FL2VA.clipType, device: 'default' } };
  wf['vae'] = { class_type: 'VAELoader', inputs: { vae_name: H3_FL2VA.videoVae } };
  // Present in the production graph (loaded but not consumed by the i2v
  // node); kept so the assembled graph matches the verified one exactly.
  wf['avae'] = { class_type: 'VAELoader', inputs: { vae_name: H3_FL2VA.audioVae } };
  wf['img'] = { class_type: 'LoadImage', inputs: { image: s.firstFrameName } };
  const i2vInputs: Record<string, any> = {
    clip: ['clip', 0],
    vae: ['vae', 0],
    first_frame: ['img', 0],
    prompt: s.prompt,
    width: s.width,
    height: s.height,
    length: s.frames,
  };
  if (s.lastFrameName) {
    wf['img_last'] = { class_type: 'LoadImage', inputs: { image: s.lastFrameName } };
    i2vInputs.last_frame = ['img_last', 0];
  }
  wf['i2v'] = { class_type: 'MiniMaxH3ImageToVideo', inputs: i2vInputs };
  wf['shift'] = {
    class_type: 'MiniMaxH3SigmaShift',
    inputs: { model: ['unet', 0], shift_audio: H3_FL2VA.shiftAudio, shift_video: H3_FL2VA.shiftVideo },
  };
  wf['sigmas'] = {
    class_type: 'BasicScheduler',
    inputs: { model: ['shift', 0], scheduler: s.scheduler, steps: s.steps, denoise: 1 },
  };
  wf['sampler'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: H3_FL2VA.sampler } };
  wf['noise'] = { class_type: 'RandomNoise', inputs: { noise_seed: s.seed } };
  wf['guider'] = { class_type: 'BasicGuider', inputs: { model: ['shift', 0], conditioning: ['i2v', 0] } };
  wf['sample'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['noise', 0],
      guider: ['guider', 0],
      sampler: ['sampler', 0],
      sigmas: ['sigmas', 0],
      latent_image: ['i2v', 1],
    },
  };
  wf['decode'] = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } };
  wf['video'] = { class_type: 'CreateVideo', inputs: { images: ['decode', 0], fps: s.fps } };
  wf['save'] = {
    class_type: 'SaveVideo',
    inputs: { video: ['video', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' },
  };
  return wf;
}

/* --------------------- MiniMax H3 Ref2VA (video) ----------------------- */

/**
 * Fixed companion files / parameters for the H3 Ref2VA production chain,
 * taken from the verified production workflows (see
 * docs/h3-ref2va-ground-truth.md — the 《临安夜巡》 graphs, cross-checked
 * against the live /object_info spec). The UNET itself is NOT fixed here:
 * it comes from the model record's file_name so base-model read-back
 * verification compares against exactly what the user configured.
 */
export const H3_REF2VA = {
  clip: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  clipType: 'minimax',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  shiftAudio: 3,
  shiftVideo: 12,
  sampler: 'res_multistep',
  refImageSize: 'match',
  maxRefImages: 9, // node spec limit; production used 1–4
} as const;

/**
 * H3 Ref2VA workflow (node ids mirror the production graphs):
 * UNETLoader -> MiniMaxH3SigmaShift (audio 3 / video 12) -> BasicScheduler
 * (simple, 20 steps) + KSamplerSelect (res_multistep) + RandomNoise feed
 * SamplerCustomAdvanced via BasicGuider; conditioning and latent come from
 * MiniMaxH3ReferenceToVideo (CLIP + video VAE + audio VAE + prompt + one
 * LoadImage per reference image [+ one LoadAudio for the reference voice]).
 * The prompt is passed through verbatim: its <Picture N> / <Audio 1> tags
 * refer to the reference slots in settings order, and assembly guarantees
 * that order matches. VAEDecode -> CreateVideo (fps from settings); only
 * when a reference audio is attached does the graph grow VAEDecodeAudio
 * and CreateVideo's audio input, exactly like the production voiced shots.
 * The audio VAE loader itself is always present: the r2v node consumes it
 * in both variants.
 *
 * At least one reference image is mandatory: callers must have uploaded
 * the images into ComfyUI's input dir and passed their names, in order,
 * as settings.refImageNames. Building without one is a hard error.
 */
export function buildH3Ref2vaWorkflow(modelFile: string, s: GenSettings, prefix: string): Record<string, any> {
  const refImages = s.refImageNames ?? [];
  if (refImages.length === 0) {
    throw new Error('h3-ref2va requires at least one reference image (settings.refImageNames is empty)');
  }
  if (refImages.length > H3_REF2VA.maxRefImages) {
    throw new Error(`h3-ref2va accepts at most ${H3_REF2VA.maxRefImages} reference images (got ${refImages.length})`);
  }
  const wf: Record<string, any> = {};
  wf['unet'] = { class_type: 'UNETLoader', inputs: { unet_name: modelFile, weight_dtype: 'default' } };
  wf['clip'] = { class_type: 'CLIPLoader', inputs: { clip_name: H3_REF2VA.clip, type: H3_REF2VA.clipType, device: 'default' } };
  wf['vae'] = { class_type: 'VAELoader', inputs: { vae_name: H3_REF2VA.videoVae } };
  wf['avae'] = { class_type: 'VAELoader', inputs: { vae_name: H3_REF2VA.audioVae } };
  const r2vInputs: Record<string, any> = {
    clip: ['clip', 0],
    vae: ['vae', 0],
    audio_vae: ['avae', 0],
    prompt: s.prompt,
    width: s.width,
    height: s.height,
    length: s.frames,
    ref_image_size: s.refImageSize ?? H3_REF2VA.refImageSize,
  };
  refImages.forEach((name, i) => {
    wf[`ref${i}`] = { class_type: 'LoadImage', inputs: { image: name } };
    r2vInputs[`ref_images.ref_image_${i}`] = [`ref${i}`, 0];
  });
  const hasAudio = Boolean(s.refAudioName);
  if (hasAudio) {
    wf['voice0'] = { class_type: 'LoadAudio', inputs: { audio: s.refAudioName } };
    r2vInputs['ref_audios.ref_audio_0'] = ['voice0', 0];
  }
  wf['i2v'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: r2vInputs };
  wf['shift'] = {
    class_type: 'MiniMaxH3SigmaShift',
    inputs: { model: ['unet', 0], shift_audio: H3_REF2VA.shiftAudio, shift_video: H3_REF2VA.shiftVideo },
  };
  wf['sigmas'] = {
    class_type: 'BasicScheduler',
    inputs: { model: ['shift', 0], scheduler: s.scheduler, steps: s.steps, denoise: 1 },
  };
  wf['sampler'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: H3_REF2VA.sampler } };
  wf['noise'] = { class_type: 'RandomNoise', inputs: { noise_seed: s.seed } };
  wf['guider'] = { class_type: 'BasicGuider', inputs: { model: ['shift', 0], conditioning: ['i2v', 0] } };
  wf['sample'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['noise', 0],
      guider: ['guider', 0],
      sampler: ['sampler', 0],
      sigmas: ['sigmas', 0],
      latent_image: ['i2v', 1],
    },
  };
  wf['decode'] = { class_type: 'VAEDecode', inputs: { samples: ['sample', 0], vae: ['vae', 0] } };
  const videoInputs: Record<string, any> = { images: ['decode', 0], fps: s.fps };
  if (hasAudio) {
    wf['decodeA'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['sample', 0], vae: ['avae', 0] } };
    videoInputs.audio = ['decodeA', 0];
  }
  wf['video'] = { class_type: 'CreateVideo', inputs: videoInputs };
  wf['save'] = {
    class_type: 'SaveVideo',
    inputs: { video: ['video', 0], filename_prefix: prefix, format: 'auto', codec: 'auto' },
  };
  return wf;
}

export function buildComfyWorkflow(adapter: string, modelFile: string, s: GenSettings, prefix: string): Record<string, any> {
  if (adapter === 'h3-image') return buildH3ImageWorkflow(modelFile, s, prefix);
  if (adapter === 'h3-fl2va') return buildH3Fl2vaWorkflow(modelFile, s, prefix);
  if (adapter === 'h3-ref2va') return buildH3Ref2vaWorkflow(modelFile, s, prefix);
  const isVideo = adapter === 'comfy-video';
  const workflow: Record<string, any> = {};
  if (isVideo) {
    workflow['1'] = { class_type: 'UNETLoader', inputs: { unet_name: modelFile, weight_dtype: 'default' } };
  } else {
    workflow['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: modelFile } };
  }
  workflow['2'] = { class_type: 'CLIPTextEncode', inputs: { text: s.prompt, clip: ['1', isVideo ? 1 : 1] } };
  workflow['3'] = isVideo
    ? { class_type: 'EmptyLatent', inputs: { width: s.width, height: s.height, length: s.frames, batch_size: 1 } }
    : { class_type: 'EmptyLatentImage', inputs: { width: s.width, height: s.height, batch_size: 1 } };
  workflow['4'] = {
    class_type: 'KSampler',
    inputs: {
      seed: s.seed,
      steps: s.steps,
      cfg: s.cfg,
      sampler_name: s.sampler,
      scheduler: s.scheduler,
      denoise: 1,
      model: ['1', 0],
      positive: ['2', 0],
      latent_image: ['3', 0],
    },
  };
  if (s.firstFrameName) {
    workflow['6'] = { class_type: 'LoadImage', inputs: { image: s.firstFrameName } };
    workflow['4'].inputs.first_frame = ['6', 0];
  }
  workflow['5'] = isVideo
    ? { class_type: 'SaveVideo', inputs: { filename_prefix: prefix, images: ['4', 0] } }
    : { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['4', 0] } };
  return workflow;
}

export interface OpenAIImageResult {
  buffer: Buffer;
  fileName: string;
  actualModel: string | null;
}

/** Submit to an OpenAI-compatible image endpoint: POST {baseUrl}/images/generations. */
export async function submitOpenAIImage(
  baseUrl: string,
  apiKey: string | null,
  modelName: string,
  s: GenSettings,
): Promise<OpenAIImageResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: modelName,
      prompt: s.prompt,
      size: `${s.width}x${s.height}`,
      n: 1,
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible image request failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  const data: any = await res.json();
  const item = data?.data?.[0];
  if (!item) throw new Error('OpenAI-compatible image request returned no data');
  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), fileName: 'api-image.png', actualModel: data.model ?? modelName };
  }
  if (item.url) {
    const img = await fetch(item.url);
    if (!img.ok) throw new Error(`Fetching generated image URL failed: HTTP ${img.status}`);
    const ext = item.url.split('.').pop()?.split('?')[0] ?? 'png';
    return { buffer: Buffer.from(await img.arrayBuffer()), fileName: `api-image.${ext}`, actualModel: data.model ?? modelName };
  }
  throw new Error('OpenAI-compatible image response had neither b64_json nor url');
}

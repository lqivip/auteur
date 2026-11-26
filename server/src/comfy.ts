/** Thin client over the ComfyUI HTTP API. All calls are plain fetch — no SDK. */

export interface ComfyOutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyHistoryEntry {
  prompt: Record<string, any>;
  outputs: Record<string, { images?: ComfyOutputFile[]; gifs?: ComfyOutputFile[]; videos?: ComfyOutputFile[] }>;
  status: { status_str?: string; completed?: boolean; messages?: any[] };
}

function base(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function jsonOrThrow(res: Response, what: string): Promise<any> {
  if (!res.ok) throw new Error(`${what} failed: HTTP ${res.status}`);
  return res.json();
}

export async function comfyObjectInfo(baseUrl: string): Promise<Record<string, any>> {
  const res = await fetch(`${base(baseUrl)}/object_info`);
  return jsonOrThrow(res, 'GET /object_info');
}

export async function comfySubmit(baseUrl: string, workflow: Record<string, any>): Promise<{ prompt_id: string; number: number }> {
  const res = await fetch(`${base(baseUrl)}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const data = await jsonOrThrow(res, 'POST /prompt');
  if (!data.prompt_id) throw new Error(`POST /prompt returned no prompt_id: ${JSON.stringify(data).slice(0, 200)}`);
  return { prompt_id: data.prompt_id, number: data.number ?? 0 };
}

export async function comfyQueue(baseUrl: string): Promise<{ running: string[]; pending: string[] }> {
  const res = await fetch(`${base(baseUrl)}/queue`);
  const data = await jsonOrThrow(res, 'GET /queue');
  const ids = (list: any[]): string[] => (Array.isArray(list) ? list.map((item) => item?.[1]).filter(Boolean) : []);
  return { running: ids(data.queue_running), pending: ids(data.queue_pending) };
}

export async function comfyHistory(baseUrl: string, promptId: string): Promise<ComfyHistoryEntry | null> {
  const res = await fetch(`${base(baseUrl)}/history/${encodeURIComponent(promptId)}`);
  const data = await jsonOrThrow(res, 'GET /history');
  return data[promptId] ?? null;
}

/** Cancel = remove a still-queued prompt from the ComfyUI queue. */
export async function comfyDeleteFromQueue(baseUrl: string, promptId: string): Promise<void> {
  const res = await fetch(`${base(baseUrl)}/queue`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ delete: [promptId] }),
  });
  if (!res.ok) throw new Error(`POST /queue (delete) failed: HTTP ${res.status}`);
}

/** Stop = interrupt the currently running prompt. */
export async function comfyInterrupt(baseUrl: string): Promise<void> {
  const res = await fetch(`${base(baseUrl)}/interrupt`, { method: 'POST' });
  if (!res.ok) throw new Error(`POST /interrupt failed: HTTP ${res.status}`);
}

export async function comfyViewFile(baseUrl: string, file: ComfyOutputFile): Promise<Buffer> {
  const qs = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' });
  const res = await fetch(`${base(baseUrl)}/view?${qs.toString()}`);
  if (!res.ok) throw new Error(`GET /view failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Parse /object_info into the model file lists the settings UI cares about. */
export function discoverModelFiles(objectInfo: Record<string, any>): { unets: string[]; checkpoints: string[]; loras: string[] } {
  const options = (node: string, input: string): string[] => {
    const spec = objectInfo?.[node]?.input?.required?.[input] ?? objectInfo?.[node]?.input?.optional?.[input];
    const first = Array.isArray(spec) ? spec[0] : undefined;
    return Array.isArray(first) ? first.filter((v: any) => typeof v === 'string') : [];
  };
  const loras = new Set<string>([
    ...options('LoraLoader', 'lora_name'),
    ...options('LoraLoaderModelOnly', 'lora_name'),
  ]);
  return {
    unets: options('UNETLoader', 'unet_name'),
    checkpoints: options('CheckpointLoaderSimple', 'ckpt_name'),
    loras: [...loras],
  };
}

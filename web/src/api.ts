async function request<T>(method: string, url: string, payload?: any): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: payload !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, payload?: any) => request<T>('POST', url, payload ?? {}),
  patch: <T>(url: string, payload: any) => request<T>('PATCH', url, payload),
  del: <T>(url: string, payload?: any) => request<T>('DELETE', url, payload),
};

export interface Project {
  id: string; name: string; short_name: string; aspect: string; aspect_custom: string | null;
  default_width: number; default_height: number; archived: number;
  created_at: string; updated_at: string; segments?: number; completed_segments?: number;
}

export interface Segment {
  id: string; storyboard_id: string; seq: number; title: string; dialogue: string; prompt: string;
  first_frame: string | null; last_frame: string | null;
  ref_images: string[]; ref_audio: string | null; aspect_override: string | null;
  width: number | null; height: number | null; frames: number | null; fps: number;
  steps: number | null; cfg: number | null; seed: number | null;
  sampler: string | null; scheduler: string | null;
  selected_take_id: string | null; status?: string;
}

export interface Take {
  id: string; segment_id: string; job_id: string | null; file_path: string; file_name: string;
  kind: string; size: number; actual_model: string | null;
  verify_status: 'verified' | 'unverified' | 'mismatch'; note: string; created_at: string;
}

export interface Job {
  id: string; segment_id: string; label: string; channel_id: string | null; model_id: string | null;
  expected_model: string | null; snapshot: any; prompt_id: string | null; queue_number: number | null;
  status: string; error: string | null; submitted_at: string; started_at: string | null; finished_at: string | null;
  segment_title?: string; project_name?: string;
}

export interface Channel {
  id: string; name: string; type: 'comfyui' | 'openai-compatible'; base_url: string;
  enabled: number; model_files: string[]; has_key: boolean; api_key_masked: string | null;
}

export interface Model {
  id: string; channel_id: string; name: string; file_name: string | null;
  capability: string; adapter: string; params: any; enabled: number;
}

export interface CharacterImage {
  id: string; character_id: string; path: string; version: string; usage: string; is_current: number;
}
export interface Character {
  id: string; project_id: string; name: string; description: string; images: CharacterImage[];
}

export function mediaUrl(relPath: string | null | undefined): string | null {
  return relPath ? `/media/${relPath}` : null;
}

/** Uploads any media file the server accepts (images, plus audio for the
 *  h3-ref2va reference-voice slot) and returns its media-relative path. */
export async function uploadMedia(file: File): Promise<string> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const result = await api.post<{ path: string }>('/api/uploads', { filename: file.name, data_base64: dataBase64 });
  return result.path;
}

export const uploadImage = uploadMedia;

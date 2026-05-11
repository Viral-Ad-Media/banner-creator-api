import { env } from '../config/env.js';
import {
  BANNER_SYSTEM_INSTRUCTION,
  clampBannerCount,
  normalizeBannerPlan,
  parseImageDataUrl,
  type BannerPlan,
  type BannerRequest,
  type VideoGenerationRequest,
  type VideoGenerationStatus,
  type VideoModelPreset,
} from './gemini.js';

type OpenRouterChatCompletion = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
};

type OpenRouterVideoJob = {
  id?: string;
  status?: string;
  error?: string | { message?: string };
  generation_id?: string | null;
  unsigned_urls?: string[];
  model?: string | null;
};

const getBaseUrl = () => env.OPENROUTER_BASE_URL.replace(/\/+$/, '');

const requireOpenRouterApiKey = () => {
  if (!env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter is selected, but OPENROUTER_API_KEY is not configured on the backend.');
  }

  return env.OPENROUTER_API_KEY;
};

const getOpenRouterHeaders = (includeJson = true): HeadersInit => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${requireOpenRouterApiKey()}`,
    'X-OpenRouter-Title': env.OPENROUTER_APP_NAME,
  };

  if (includeJson) {
    headers['Content-Type'] = 'application/json';
  }

  if (env.OPENROUTER_APP_URL) {
    headers['HTTP-Referer'] = env.OPENROUTER_APP_URL;
  }

  return headers;
};

const readResponsePayload = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const getPayloadErrorMessage = (payload: unknown) => {
  if (typeof payload === 'string' && payload.trim()) return payload;
  if (!payload || typeof payload !== 'object') return undefined;

  const error = (payload as { error?: unknown }).error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }

  const message = (payload as { message?: unknown }).message;
  if (typeof message === 'string' && message.trim()) return message;

  return undefined;
};

const openRouterFetchJson = async <T>(
  path: string,
  options: RequestInit = {},
  acceptedStatuses: number[] = [200]
) => {
  const response = await fetch(`${getBaseUrl()}${path}`, {
    ...options,
    headers: {
      ...getOpenRouterHeaders(options.body !== undefined),
      ...(options.headers || {}),
    },
  });
  const payload = await readResponsePayload(response);

  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(
      getPayloadErrorMessage(payload) ||
        `OpenRouter request failed: ${response.status} ${response.statusText}`
    );
  }

  return payload as T;
};

const extractOpenRouterMessageText = (completion: OpenRouterChatCompletion) => {
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => part.text)
      .filter((text): text is string => typeof text === 'string')
      .join('\n')
      .trim();
  }

  return undefined;
};

const parseBannerPlanJson = (rawText: string) => {
  const stripped = rawText.replace(/```(?:json)?\n?|\n?```/g, '').trim();

  try {
    return JSON.parse(stripped) as BannerPlan;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as BannerPlan;
    }

    throw new Error('Invalid JSON returned for banner plan.');
  }
};

const buildBannerPrompt = (request: BannerRequest, bannerCount: number) => `
User Prompt: ${request.userPrompt}
Aspect Ratio: ${request.aspectRatio}
Total Banner Images Requested: ${bannerCount}
Has Background Upload: ${request.hasBackgroundImage}
Has Asset Upload: ${request.hasAssetImage}
`;

export const generateBannerPlanWithOpenRouter = async (request: BannerRequest): Promise<BannerPlan> => {
  const bannerCount = clampBannerCount(request.bannerCount);
  const completion = await openRouterFetchJson<OpenRouterChatCompletion>('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: env.OPENROUTER_TEXT_MODEL,
      messages: [
        {
          role: 'system',
          content: `${BANNER_SYSTEM_INSTRUCTION}\nReturn only a valid JSON object. Do not wrap it in Markdown.`,
        },
        {
          role: 'user',
          content: buildBannerPrompt(request, bannerCount),
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_completion_tokens: 8192,
    }),
  });

  const rawText = extractOpenRouterMessageText(completion);
  if (!rawText) {
    throw new Error('No banner plan returned from OpenRouter.');
  }

  return normalizeBannerPlan(parseBannerPlanJson(rawText), bannerCount);
};

const getOpenRouterVideoModelId = (preset: VideoModelPreset = 'fast') =>
  preset === 'quality' ? env.OPENROUTER_VIDEO_MODEL_QUALITY : env.OPENROUTER_VIDEO_MODEL_FAST;

const getOpenRouterVideoErrorMessage = (job: OpenRouterVideoJob) => {
  if (typeof job.error === 'string' && job.error.trim()) return job.error;
  if (job.error && typeof job.error === 'object' && typeof job.error.message === 'string') {
    return job.error.message;
  }
  return 'OpenRouter video generation failed.';
};

const mapOpenRouterVideoStatus = (
  job: OpenRouterVideoJob,
  modelId: string
): VideoGenerationStatus => {
  const normalizedStatus = (job.status || 'pending').toLowerCase();
  const operationName = job.id || '';

  if (normalizedStatus === 'completed' || normalizedStatus === 'succeeded' || normalizedStatus === 'success') {
    return {
      operationName,
      status: 'SUCCEEDED',
      done: true,
      mimeType: 'video/mp4',
      modelId,
      provider: 'openrouter',
    };
  }

  if (
    normalizedStatus === 'failed' ||
    normalizedStatus === 'cancelled' ||
    normalizedStatus === 'canceled' ||
    normalizedStatus === 'expired'
  ) {
    return {
      operationName,
      status: 'FAILED',
      done: true,
      errorMessage: getOpenRouterVideoErrorMessage(job),
      modelId,
      provider: 'openrouter',
    };
  }

  return {
    operationName,
    status: normalizedStatus === 'pending' || normalizedStatus === 'queued' ? 'PENDING' : 'RUNNING',
    done: false,
    modelId,
    provider: 'openrouter',
  };
};

const getSourceImageUrl = (sourceImageDataUrl: string) => {
  const parsed = parseImageDataUrl(sourceImageDataUrl);
  return `data:${parsed.mimeType};base64,${parsed.data}`;
};

export const startOpenRouterVideoGeneration = async (
  request: VideoGenerationRequest
): Promise<VideoGenerationStatus> => {
  const modelId = getOpenRouterVideoModelId(request.modelPreset);
  const prompt = request.negativePrompt?.trim()
    ? `${request.prompt}\n\nAvoid: ${request.negativePrompt.trim()}`
    : request.prompt;

  const body: Record<string, unknown> = {
    model: modelId,
    prompt,
    aspect_ratio: request.aspectRatio || '16:9',
    duration: request.durationSeconds || 8,
    resolution: '720p',
    generate_audio: request.includeAudio ?? false,
  };

  if (request.sourceImageDataUrl) {
    body.frame_images = [
      {
        type: 'image_url',
        image_url: {
          url: getSourceImageUrl(request.sourceImageDataUrl),
        },
        frame_type: 'first_frame',
      },
    ];
  }

  const job = await openRouterFetchJson<OpenRouterVideoJob>(
    '/videos',
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
    [200, 202]
  );

  if (!job.id) {
    throw new Error('OpenRouter video generation did not return a job id.');
  }

  return mapOpenRouterVideoStatus(job, modelId);
};

export const getOpenRouterVideoGenerationStatus = async (
  operationName: string,
  modelPreset?: VideoModelPreset
) => {
  const modelId = getOpenRouterVideoModelId(modelPreset);
  const job = await openRouterFetchJson<OpenRouterVideoJob>(`/videos/${encodeURIComponent(operationName)}`);
  return mapOpenRouterVideoStatus(job, modelId);
};

export const downloadOpenRouterGeneratedVideo = async (
  operationName: string,
  modelPreset?: VideoModelPreset
): Promise<{ buffer: Buffer; mimeType: string }> => {
  const modelId = getOpenRouterVideoModelId(modelPreset);
  const job = await openRouterFetchJson<OpenRouterVideoJob>(`/videos/${encodeURIComponent(operationName)}`);
  const status = mapOpenRouterVideoStatus(job, modelId);

  if (status.status === 'FAILED') {
    throw new Error(status.errorMessage || 'OpenRouter video generation failed.');
  }

  if (!status.done) {
    throw new Error('Video is still generating. Please wait for completion before downloading.');
  }

  const downloadUrl = job.unsigned_urls?.[0] || `${getBaseUrl()}/videos/${encodeURIComponent(operationName)}/content?index=0`;
  const needsAuth = downloadUrl.startsWith(getBaseUrl()) || downloadUrl.startsWith('/api/');
  const response = await fetch(downloadUrl.startsWith('/api/') ? `https://openrouter.ai${downloadUrl}` : downloadUrl, {
    headers: needsAuth ? getOpenRouterHeaders(false) : undefined,
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to download OpenRouter video: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get('content-type') || 'video/mp4',
  };
};

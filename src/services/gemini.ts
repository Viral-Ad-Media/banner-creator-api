import { GenerateVideosOperation, GoogleGenAI, Modality, Schema, Type } from '@google/genai';
import { env } from '../config/env.js';

export type AspectRatio = '1:1' | '16:9' | '9:16' | '3:4' | '4:5';
export type VideoAspectRatio = '16:9' | '9:16';
export type VideoDurationSeconds = 4 | 6 | 8;
export type VideoModelPreset = 'fast' | 'quality';

export interface BannerRequest {
  userPrompt: string;
  aspectRatio: AspectRatio;
  bannerCount?: number;
  hasBackgroundImage?: boolean;
  hasAssetImage?: boolean;
}

export interface BannerPlan {
  main_banner: {
    headline: string;
    subheadline: string;
    image_prompt: string;
    description: string;
    cta: string;
  };
  additional_banners: {
    title: string;
    subtitle: string;
    image_prompt: string;
    description: string;
    cta: string;
  }[];
  seo: {
    caption: string;
    hashtags: string[];
    keywords: string[];
  };
}

export interface VideoGenerationRequest {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: VideoAspectRatio;
  durationSeconds?: VideoDurationSeconds;
  modelPreset?: VideoModelPreset;
  includeAudio?: boolean;
  sourceImageDataUrl?: string;
}

export interface VideoGenerationStatus {
  operationName: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  done: boolean;
  errorMessage?: string;
  mimeType?: string;
  modelId?: string;
}

type BannerVariant = BannerPlan['additional_banners'][number];

const DEFAULT_BANNER_COUNT = 3;
const MIN_BANNER_COUNT = 1;
const MAX_BANNER_COUNT = 6;

let client: GoogleGenAI | null = null;

const getClient = () => {
  if (client) return client;
  client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return client;
};

const extractResponseText = (response: any): string | undefined => {
  if (typeof response?.text === 'function') return response.text();
  if (typeof response?.response?.text === 'function') return response.response.text();
  if (typeof response?.text === 'string') return response.text;
  return undefined;
};

const parseImageDataUrl = (imageDataUrl: string): { mimeType: string; data: string } => {
  const match = imageDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error('Invalid image data URL format.');
  }

  return {
    mimeType: match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase(),
    data: match[2].replace(/\s/g, ''),
  };
};

const BANNER_SYSTEM_INSTRUCTION = `
You are an Elite AI Creative Director and Social Media Strategist.
Your goal is to design a high-quality, ready-to-render social media banner campaign based on the user's request.

**CRITICAL RULE: VISUAL PROMPTS**
- The 'image_prompt' MUST describe a visual scene for a background.
- Do NOT use words like "no text" or "text free" inside the image_prompt.
- Avoid celebrity names and copyrighted characters.
- If style is not specified, default to modern, commercial-grade creative direction.

**CORE CAPABILITIES & LOGIC:**
1. Analyze user prompt for topic, intent, and style.
2. Create concise high-impact copy.
3. If hasBackgroundImage is true, use image_prompt "User provided background".
4. Return exactly the number of requested creatives: 1 main banner plus N-1 items in additional_banners.
5. If the requested count is 1, additional_banners must be an empty array.
6. Make each additional banner a distinct but on-brand variation.
7. Always include CTA.

Return strict JSON with fields: main_banner, additional_banners, seo.
`;

const clampBannerCount = (value?: number) =>
  Math.max(MIN_BANNER_COUNT, Math.min(MAX_BANNER_COUNT, value ?? DEFAULT_BANNER_COUNT));

const getVideoModelId = (preset: VideoModelPreset = 'fast') =>
  preset === 'quality' ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';

const getVideoErrorMessage = (error: Record<string, unknown> | undefined) => {
  if (!error) return undefined;

  if (typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }

  if (typeof error.details === 'string' && error.details.trim()) {
    return error.details;
  }

  return 'Video generation failed.';
};

const buildVideoOperation = (operationName: string) => {
  const operation = new GenerateVideosOperation();
  operation.name = operationName;
  return operation;
};

const getVideoOperationStatus = async (operationName: string) => {
  const operation = await getClient().operations.getVideosOperation({
    operation: buildVideoOperation(operationName),
  });

  return operation;
};

const mapVideoStatus = (operation: GenerateVideosOperation, modelId?: string): VideoGenerationStatus => {
  if (operation.done) {
    const generatedVideo = operation.response?.generatedVideos?.[0]?.video;

    if (operation.error) {
      return {
        operationName: operation.name || '',
        status: 'FAILED',
        done: true,
        errorMessage: getVideoErrorMessage(operation.error),
        modelId,
      };
    }

    if (!generatedVideo?.uri && !generatedVideo?.videoBytes) {
      return {
        operationName: operation.name || '',
        status: 'FAILED',
        done: true,
        errorMessage: 'Video generation finished without a downloadable output.',
        modelId,
      };
    }

    return {
      operationName: operation.name || '',
      status: 'SUCCEEDED',
      done: true,
      mimeType: generatedVideo.mimeType || 'video/mp4',
      modelId,
    };
  }

  return {
    operationName: operation.name || '',
    status: 'RUNNING',
    done: false,
    modelId,
  };
};

const createFallbackVariant = (plan: BannerPlan, index: number): BannerVariant => ({
  title: `${plan.main_banner.headline} ${index + 2}`,
  subtitle: plan.main_banner.subheadline,
  image_prompt: plan.main_banner.image_prompt,
  description: plan.main_banner.description,
  cta: plan.main_banner.cta,
});

const normalizeBannerPlan = (plan: BannerPlan, bannerCount: number): BannerPlan => {
  const desiredAdditionalCount = Math.max(0, bannerCount - 1);
  const normalizedAdditional = (Array.isArray(plan.additional_banners) ? plan.additional_banners : []).slice(0, desiredAdditionalCount);

  while (normalizedAdditional.length < desiredAdditionalCount) {
    const fallback = normalizedAdditional[normalizedAdditional.length - 1] ?? createFallbackVariant(plan, normalizedAdditional.length);
    normalizedAdditional.push({
      title: fallback.title || plan.main_banner.headline,
      subtitle: fallback.subtitle || plan.main_banner.subheadline,
      image_prompt: fallback.image_prompt || plan.main_banner.image_prompt,
      description: fallback.description || plan.main_banner.description,
      cta: fallback.cta || plan.main_banner.cta,
    });
  }

  return {
    ...plan,
    additional_banners: normalizedAdditional,
  };
};

export const generateBannerPlan = async (request: BannerRequest): Promise<BannerPlan> => {
  const bannerCount = clampBannerCount(request.bannerCount);
  const prompt = `
User Prompt: ${request.userPrompt}
Aspect Ratio: ${request.aspectRatio}
Total Banner Images Requested: ${bannerCount}
Has Background Upload: ${request.hasBackgroundImage}
Has Asset Upload: ${request.hasAssetImage}
`;

  const response = await getClient().models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      systemInstruction: BANNER_SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      temperature: 0.5,
      maxOutputTokens: 8192,
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          main_banner: {
            type: Type.OBJECT,
            properties: {
              headline: { type: Type.STRING },
              subheadline: { type: Type.STRING },
              image_prompt: { type: Type.STRING },
              description: { type: Type.STRING },
              cta: { type: Type.STRING },
            },
            required: ['headline', 'subheadline', 'image_prompt', 'description', 'cta'],
          },
          additional_banners: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                subtitle: { type: Type.STRING },
                image_prompt: { type: Type.STRING },
                description: { type: Type.STRING },
                cta: { type: Type.STRING },
              },
              required: ['title', 'subtitle', 'image_prompt', 'description', 'cta'],
            },
          },
          seo: {
            type: Type.OBJECT,
            properties: {
              caption: { type: Type.STRING },
              hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
              keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
            },
            required: ['caption', 'hashtags', 'keywords'],
          },
        },
        required: ['main_banner', 'additional_banners', 'seo'],
      } as Schema,
    },
  });

  const rawText = extractResponseText(response);
  if (!rawText) {
    throw new Error('No banner plan returned from Gemini.');
  }

  try {
    const jsonText = rawText.replace(/```json\n?|\n?```/g, '').trim();
    return normalizeBannerPlan(JSON.parse(jsonText) as BannerPlan, bannerCount);
  } catch {
    throw new Error('Invalid JSON returned for banner plan.');
  }
};

export const startVideoGeneration = async (request: VideoGenerationRequest): Promise<VideoGenerationStatus> => {
  const modelId = getVideoModelId(request.modelPreset);
  const sourceImage = request.sourceImageDataUrl
    ? (() => {
        const parsedImage = parseImageDataUrl(request.sourceImageDataUrl!);
        return {
          imageBytes: parsedImage.data,
          mimeType: parsedImage.mimeType,
        };
      })()
    : undefined;

  try {
    const operation = await getClient().models.generateVideos({
      model: modelId,
      prompt: request.prompt,
      ...(sourceImage ? { image: sourceImage } : {}),
      config: {
        numberOfVideos: 1,
        aspectRatio: request.aspectRatio || '16:9',
        durationSeconds: request.durationSeconds || 4,
        resolution: '720p',
        negativePrompt: request.negativePrompt,
        generateAudio: request.includeAudio ?? false,
      },
    });

    if (!operation.name) {
      throw new Error('Video generation did not return an operation name.');
    }

    return {
      operationName: operation.name,
      status: 'PENDING',
      done: false,
      modelId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start video generation.';
    throw new Error(
      `${message} Veo generation requires Gemini API access to the selected video model.`
    );
  }
};

export const getVideoGenerationStatus = async (
  operationName: string,
  modelPreset?: VideoModelPreset
): Promise<VideoGenerationStatus> => {
  const modelId = getVideoModelId(modelPreset);
  const operation = await getVideoOperationStatus(operationName);
  return mapVideoStatus(operation, modelId);
};

export const downloadGeneratedVideo = async (
  operationName: string
): Promise<{ buffer: Buffer; mimeType: string }> => {
  const operation = await getVideoOperationStatus(operationName);
  const status = mapVideoStatus(operation);

  if (status.status === 'FAILED') {
    throw new Error(status.errorMessage || 'Video generation failed.');
  }

  if (!status.done) {
    throw new Error('Video is still generating. Please wait for completion before downloading.');
  }

  const generatedVideo = operation.response?.generatedVideos?.[0]?.video;
  if (!generatedVideo) {
    throw new Error('Generated video file was not found.');
  }

  if (generatedVideo.videoBytes) {
    return {
      buffer: Buffer.from(generatedVideo.videoBytes, 'base64'),
      mimeType: generatedVideo.mimeType || 'video/mp4',
    };
  }

  if (!generatedVideo.uri) {
    throw new Error('Generated video is missing a download URL.');
  }

  const response = await fetch(generatedVideo.uri, {
    headers: {
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to download generated video: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get('content-type') || generatedVideo.mimeType || 'video/mp4',
  };
};

export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio,
  referenceImages: string[] = []
): Promise<string> => {
  if (!prompt) throw new Error('Image prompt is required.');

  if (prompt.toLowerCase().includes('user provided background')) {
    return referenceImages[0] || '';
  }

  const executeGen = async (promptText: string) => {
    const referenceParts = referenceImages
      .slice(0, 2)
      .map((imageDataUrl) => {
        try {
          const parsedImage = parseImageDataUrl(imageDataUrl);
          return {
            inlineData: {
              mimeType: parsedImage.mimeType,
              data: parsedImage.data,
            },
          };
        } catch {
          return null;
        }
      })
      .filter((part): part is { inlineData: { mimeType: string; data: string } } => part !== null);

    const response = await getClient().models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ text: promptText }, ...referenceParts],
      config: {
        responseModalities: [Modality.TEXT, Modality.IMAGE],
        imageConfig: {
          aspectRatio: aspectRatio === '4:5' ? '3:4' : aspectRatio,
        },
      },
    });

    const outputParts = response.candidates?.[0]?.content?.parts;
    if (!outputParts) throw new Error('No image content generated.');

    for (const part of outputParts) {
      if (part.inlineData?.data) {
        return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
      }
    }

    const textPart = outputParts.find((part) => part.text);
    if (textPart?.text) {
      throw new Error(textPart.text);
    }

    throw new Error('No image data returned by model.');
  };

  try {
    return await executeGen(
      `Professional photography, ${prompt}. Cinematic lighting, highly detailed, premium quality, clean background.`
    );
  } catch (error) {
    const fallbackError = error instanceof Error ? error : new Error('Primary image generation attempt failed.');

    try {
      return await executeGen(`Artistic illustration, ${prompt}. Minimalist, abstract, high quality.`);
    } catch (fallback) {
      const fallbackMessage = fallback instanceof Error ? fallback.message : 'Fallback image generation attempt failed.';
      throw new Error(`Image generation failed. ${fallbackMessage} Primary attempt: ${fallbackError.message}`);
    }
  }
};

export const editImage = async (base64Image: string, prompt: string): Promise<string> => {
  if (!prompt.trim()) throw new Error('Edit prompt is required.');

  const parsedImage = parseImageDataUrl(base64Image);

  const response = await getClient().models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: [
      { text: prompt },
      {
        inlineData: {
          mimeType: parsedImage.mimeType,
          data: parsedImage.data,
        },
      },
    ],
    config: {
      responseModalities: [Modality.TEXT, Modality.IMAGE],
    },
  });

  const parts = response.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error('No edited output returned by model.');

  for (const part of parts) {
    if (part.inlineData?.data) {
      return `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
    }
  }

  const textPart = parts.find((part) => part.text);
  if (textPart?.text) {
    throw new Error(`Model did not return an image: ${textPart.text}`);
  }

  throw new Error('No image data found in edit response.');
};

import { GoogleGenAI, Schema, Type } from '@google/genai';
import { env } from '../config/env.js';

export type AspectRatio = '1:1' | '16:9' | '9:16' | '3:4' | '4:5';

export interface BannerRequest {
  userPrompt: string;
  aspectRatio: AspectRatio;
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
4. If prompt implies multiple items, return additional banners.
5. Always include CTA.

Return strict JSON with fields: main_banner, additional_banners, seo.
`;

export const generateBannerPlan = async (request: BannerRequest): Promise<BannerPlan> => {
  const prompt = `
User Prompt: ${request.userPrompt}
Aspect Ratio: ${request.aspectRatio}
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
    return JSON.parse(jsonText) as BannerPlan;
  } catch {
    throw new Error('Invalid JSON returned for banner plan.');
  }
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
      contents: {
        parts: [{ text: promptText }, ...referenceParts],
      },
      config: {
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
  } catch {
    return executeGen(`Artistic illustration, ${prompt}. Minimalist, abstract, high quality.`);
  }
};

export const editImage = async (base64Image: string, prompt: string): Promise<string> => {
  if (!prompt.trim()) throw new Error('Edit prompt is required.');

  const parsedImage = parseImageDataUrl(base64Image);

  const response = await getClient().models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType: parsedImage.mimeType,
            data: parsedImage.data,
          },
        },
      ],
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

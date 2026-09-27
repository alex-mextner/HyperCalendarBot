export interface Candidate {
  id: string;
  provider: string;
  model: string;
  keyEnv: string;
  baseURL: string;
  effort?: 'none' | 'low' | 'medium';
  inputPrice: number;
  outputPrice: number;
  priceKind: 'listed' | 'conservative-envelope';
  spacingMs?: number;
}
export const candidates: Candidate[] = [
  {
    id: 'groq-20-low',
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    keyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    effort: 'low',
    inputPrice: 0.075,
    outputPrice: 0.3,
    priceKind: 'listed',
  },
  {
    id: 'groq-120-low',
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    keyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    effort: 'low',
    inputPrice: 0.15,
    outputPrice: 0.6,
    priceKind: 'listed',
  },
  {
    id: 'groq-120-medium',
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    keyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    effort: 'medium',
    inputPrice: 0.15,
    outputPrice: 0.6,
    priceKind: 'listed',
  },
  {
    id: 'groq-qwen38',
    provider: 'groq',
    model: 'qwen/qwen3.8-27b',
    keyEnv: 'GROQ_API_KEY',
    baseURL: 'https://api.groq.com/openai/v1',
    effort: 'none',
    inputPrice: 0.8,
    outputPrice: 4,
    priceKind: 'listed',
  },
  {
    id: 'cerebras-120-low',
    provider: 'cerebras',
    model: 'gpt-oss-120b',
    keyEnv: 'CEREBRAS_KEY',
    baseURL: 'https://api.cerebras.ai/v1',
    effort: 'low',
    inputPrice: 1,
    outputPrice: 3,
    priceKind: 'conservative-envelope',
  },
  {
    id: 'together-120-low',
    provider: 'together',
    model: 'openai/gpt-oss-120b',
    keyEnv: 'TOGETHER_KEY',
    baseURL: 'https://api.together.ai/v1',
    effort: 'low',
    inputPrice: 0.15,
    outputPrice: 0.6,
    priceKind: 'listed',
  },
  {
    id: 'gemini25-none',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    effort: 'none',
    inputPrice: 0.3,
    outputPrice: 2.5,
    priceKind: 'conservative-envelope',
    spacingMs: 5000,
  },
  {
    id: 'gemini25-default',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    keyEnv: 'GEMINI_API_KEY',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    inputPrice: 0.3,
    outputPrice: 2.5,
    priceKind: 'conservative-envelope',
    spacingMs: 5000,
  },
  {
    id: 'together-glm53',
    provider: 'together',
    model: 'zai-org/GLM-5.3',
    keyEnv: 'TOGETHER_KEY',
    baseURL: 'https://api.together.ai/v1',
    inputPrice: 1.4,
    outputPrice: 4.4,
    priceKind: 'listed',
  },
];

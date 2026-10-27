// src/services/ai/streaming/logger.ts
// The one logger every streaming module shares, so all provider-round lines carry the same module tag.

import { logger } from '../../../utils/logger.ts';

export const aiLogger = logger.child({ module: 'ai-stream' });

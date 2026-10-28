import { describe, expect, spyOn, test } from 'bun:test';
import type { SpeechServices } from '../../src/bootstrap/runtime.ts';
import { createVoiceCallTts, type StressTextTools } from '../../src/bootstrap/voice-calls.ts';
import { KokoroTtsService } from '../../src/services/voice/kokoro-tts-service.ts';
import { SileroTtsService } from '../../src/services/voice/silero-tts-service.ts';
import { StressDictionary } from '../../src/services/voice/stress-dictionary.ts';
import { TtsService } from '../../src/services/voice/tts-service.ts';

const tools: StressTextTools = {
  numbersToWords: (text) => `words(${text})`,
  markStress: (text) => `stressed(${text})`,
};

const audio = (label: string) => Buffer.from(label);

function services() {
  const silero = new SileroTtsService('python');
  const kokoro = new KokoroTtsService('hf-token');
  const fallback = new TtsService();
  const spies = {
    silero: spyOn(silero, 'synthesize').mockResolvedValue(audio('silero')),
    kokoro: spyOn(kokoro, 'synthesize').mockResolvedValue(audio('kokoro')),
    fallback: spyOn(fallback, 'synthesize').mockResolvedValue(audio('google')),
  };
  const speech: SpeechServices = {
    sileroTts: silero,
    kokoroTts: kokoro,
    fallbackTts: fallback,
    stressDictionary: new StressDictionary({}),
  };
  return { speech, spies };
}

describe('createVoiceCallTts', () => {
  test('Russian goes through Silero with numbers expanded and stress marked, newlines flattened', async () => {
    const { speech, spies } = services();

    const result = await createVoiceCallTts(speech, tools).synthesize('привет\nмир', 'ru');

    expect(result.toString()).toBe('silero');
    expect(spies.silero).toHaveBeenCalledWith('stressed(words(привет мир))');
    expect(spies.fallback).not.toHaveBeenCalled();
  });

  test('English goes through Kokoro', async () => {
    const { speech, spies } = services();

    const result = await createVoiceCallTts(speech, tools).synthesize('hello\nthere', 'en');

    expect(result.toString()).toBe('kokoro');
    expect(spies.kokoro).toHaveBeenCalledWith('hello there');
  });

  test('a failing Silero falls back to Google', async () => {
    const { speech, spies } = services();
    spies.silero.mockRejectedValue(new Error('python crashed'));

    const result = await createVoiceCallTts(speech, tools).synthesize('привет', 'ru');

    expect(result.toString()).toBe('google');
    expect(spies.fallback).toHaveBeenCalledWith('привет', 'ru');
  });

  test('a failing Kokoro falls back to Google', async () => {
    const { speech, spies } = services();
    spies.kokoro.mockRejectedValue(new Error('hf down'));

    const result = await createVoiceCallTts(speech, tools).synthesize('hello', 'en');

    expect(result.toString()).toBe('google');
    expect(spies.fallback).toHaveBeenCalledWith('hello', 'en');
  });

  test('Russian without a stress dictionary skips Silero', async () => {
    const { speech, spies } = services();
    speech.stressDictionary = undefined;

    const result = await createVoiceCallTts(speech, tools).synthesize('привет', 'ru');

    expect(result.toString()).toBe('google');
    expect(spies.silero).not.toHaveBeenCalled();
  });

  test('any other language uses the Google fallback', async () => {
    const { speech, spies } = services();

    await createVoiceCallTts(speech, tools).synthesize('hola', 'es');

    expect(spies.fallback).toHaveBeenCalledWith('hola', 'es');
    expect(spies.kokoro).not.toHaveBeenCalled();
  });

  test('services filled into `speech` after the adapter was built are picked up on the next call', async () => {
    const speech: SpeechServices = {};
    const tts = createVoiceCallTts(speech, tools);
    await expect(tts.synthesize('hello', 'en')).rejects.toThrow('Fallback TTS is not initialised');

    const fallback = new TtsService();
    spyOn(fallback, 'synthesize').mockResolvedValue(audio('late'));
    speech.fallbackTts = fallback;

    expect((await tts.synthesize('hello', 'en')).toString()).toBe('late');
  });
});

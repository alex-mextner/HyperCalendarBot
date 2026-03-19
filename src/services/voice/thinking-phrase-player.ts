const START_PHRASES: Record<string, string[]> = {
  ru: ['start_hmm', 'start_sec', 'start_look', 'start_think'],
  en: ['start_hmm', 'start_sec', 'start_look', 'start_think'],
};

const MID_PHRASES: Record<string, string[]> = {
  ru: ['mid_checking', 'mid_moment', 'mid_almost', 'mid_looking'],
  en: ['mid_checking', 'mid_moment', 'mid_almost', 'mid_looking'],
};

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function phrasePath(lang: string, name: string): string {
  return `data/thinking-phrases/${lang}/${name}.ogg`;
}

export interface ThinkingPhrasePlayerOpts {
  midDelay1Ms?: number;
  midDelay2Ms?: number;
}

export type SendCmd = (cmd: { type: string; file?: string }) => void;

export class ThinkingPhrasePlayer {
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(private readonly lang: 'ru' | 'en') {}

  start(sendCmd: SendCmd, opts: ThinkingPhrasePlayerOpts = {}): void {
    const midDelay1 = opts.midDelay1Ms ?? this.randomDelay(3000, 5000);
    const midDelay2 = opts.midDelay2Ms ?? this.randomDelay(7000, 10000);

    // t=0: play start phrase
    sendCmd({ type: 'STOP' });
    sendCmd({ type: 'PLAY', file: phrasePath(this.lang, randomFrom(START_PHRASES[this.lang])) });

    const t1 = setTimeout(() => {
      sendCmd({ type: 'STOP' });
      sendCmd({ type: 'PLAY', file: phrasePath(this.lang, randomFrom(MID_PHRASES[this.lang])) });
    }, midDelay1);

    const t2 = setTimeout(() => {
      sendCmd({ type: 'STOP' });
      sendCmd({ type: 'PLAY', file: phrasePath(this.lang, randomFrom(MID_PHRASES[this.lang])) });
    }, midDelay2);

    this.timers = [t1, t2];
  }

  cancel(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private randomDelay(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}

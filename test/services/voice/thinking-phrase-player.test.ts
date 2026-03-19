import { expect, mock, test } from 'bun:test';
import { ThinkingPhrasePlayer } from '../../../src/services/voice/thinking-phrase-player.ts';

function makePlayer(lang: 'ru' | 'en' = 'ru') {
  const sendCmd = mock((_cmd: { type: string; file?: string }) => {});
  const player = new ThinkingPhrasePlayer(lang);
  return { player, sendCmd };
}

test('sends STOP then PLAY start phrase immediately on start()', () => {
  const { player, sendCmd } = makePlayer();
  player.start(sendCmd);
  // STOP + PLAY for the start phrase
  expect(sendCmd).toHaveBeenCalledTimes(2);
  const stop = (sendCmd.mock.calls[0] as [{ type: string; file?: string }])[0];
  const play = (sendCmd.mock.calls[1] as [{ type: string; file?: string }])[0];
  expect(stop.type).toBe('STOP');
  expect(play.type).toBe('PLAY');
  expect(play.file).toMatch(/data\/thinking-phrases\/ru\/start_/);
  player.cancel();
});

test('cancel() prevents mid phrase timers from firing', async () => {
  const { player, sendCmd } = makePlayer();
  player.start(sendCmd, { midDelay1Ms: 10, midDelay2Ms: 20 });
  player.cancel();
  // Wait longer than the timers
  await new Promise((r) => setTimeout(r, 50));
  // Only the initial STOP + PLAY for start phrase
  expect(sendCmd).toHaveBeenCalledTimes(2);
});

test('fires STOP+PLAY mid phrase after midDelay1Ms', async () => {
  const { player, sendCmd } = makePlayer();
  player.start(sendCmd, { midDelay1Ms: 30, midDelay2Ms: 10000 });
  await new Promise((r) => setTimeout(r, 50));
  player.cancel();
  // start: STOP+PLAY, mid: STOP+PLAY
  expect(sendCmd).toHaveBeenCalledTimes(4);
  const midPlay = (sendCmd.mock.calls[3] as [{ type: string; file?: string }])[0];
  expect(midPlay.file).toMatch(/mid_/);
});

test('uses EN phrases for lang=en', () => {
  const { player, sendCmd } = makePlayer('en');
  player.start(sendCmd);
  // calls[0] = STOP, calls[1] = PLAY
  const play = (sendCmd.mock.calls[1] as [{ type: string; file?: string }])[0];
  expect(play.file).toMatch(/data\/thinking-phrases\/en\/start_/);
  player.cancel();
});

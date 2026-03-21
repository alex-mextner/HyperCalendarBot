import { describe, expect, mock, test } from 'bun:test';
import { runPipeline } from '../../../src/bot/pipeline/pipeline.ts';
import type { FeedbackThreadContext, PipelineLayer } from '../../../src/bot/pipeline/types.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';

function makeCtx(): BotCommandContext {
  return { send: mock(() => Promise.resolve()) } as unknown as BotCommandContext;
}

describe('runPipeline', () => {
  test('stops at first layer that returns handled:true', async () => {
    const calls: string[] = [];

    const layer1: PipelineLayer = async () => {
      calls.push('layer1');
      return { handled: true };
    };
    const layer2: PipelineLayer = async () => {
      calls.push('layer2');
      return { handled: true };
    };

    await runPipeline(makeCtx(), 'hello', [layer1, layer2]);
    expect(calls).toEqual(['layer1']);
  });

  test('runs all layers if none handle the message', async () => {
    const calls: string[] = [];

    const layer1: PipelineLayer = async () => {
      calls.push('layer1');
      return { handled: false };
    };
    const layer2: PipelineLayer = async () => {
      calls.push('layer2');
      return { handled: false };
    };
    const layer3: PipelineLayer = async () => {
      calls.push('layer3');
      return { handled: false };
    };

    await runPipeline(makeCtx(), 'hello', [layer1, layer2, layer3]);
    expect(calls).toEqual(['layer1', 'layer2', 'layer3']);
  });

  test('passes feedbackContext from one layer to the next', async () => {
    const feedbackContext: FeedbackThreadContext = {
      threadId: 42,
      subject: 'bug report',
      messages: [{ sender: 'user', text: 'help' }],
    };

    let receivedContext: FeedbackThreadContext | undefined;

    const providerLayer: PipelineLayer = async () => {
      return { handled: false, feedbackContext };
    };

    const consumerLayer: PipelineLayer = async (_ctx, _text, extra) => {
      receivedContext = extra?.feedbackContext;
      return { handled: true };
    };

    await runPipeline(makeCtx(), 'hello', [providerLayer, consumerLayer]);
    expect(receivedContext).toEqual(feedbackContext);
  });

  test('feedbackContext does not bleed between separate pipeline runs', async () => {
    const feedbackContext: FeedbackThreadContext = {
      threadId: 1,
      subject: 'test',
      messages: [],
    };

    let receivedInSecondRun: FeedbackThreadContext | undefined;

    const providerLayer: PipelineLayer = async () => ({ handled: false, feedbackContext });
    const noopLayer: PipelineLayer = async () => ({ handled: false });
    const consumerLayer: PipelineLayer = async (_ctx, _text, extra) => {
      receivedInSecondRun = extra?.feedbackContext;
      return { handled: false };
    };

    // First run passes context; second run (different layers) should not carry it
    await runPipeline(makeCtx(), 'msg1', [providerLayer, noopLayer]);
    await runPipeline(makeCtx(), 'msg2', [noopLayer, consumerLayer]);

    expect(receivedInSecondRun).toBeUndefined();
  });

  test('passes messageText to each layer', async () => {
    const received: string[] = [];

    const layer: PipelineLayer = async (_ctx, text) => {
      received.push(text);
      return { handled: false };
    };

    await runPipeline(makeCtx(), 'test message', [layer, layer]);
    expect(received).toEqual(['test message', 'test message']);
  });

  test('works with empty layers array', async () => {
    await expect(runPipeline(makeCtx(), 'hello', [])).resolves.toBeUndefined();
  });

  test('continues past layer that returns needsSupplement:true', async () => {
    const calls: string[] = [];

    const layer1: PipelineLayer = async () => {
      calls.push('layer1');
      return { handled: true, needsSupplement: true };
    };
    const layer2: PipelineLayer = async () => {
      calls.push('layer2');
      return { handled: true };
    };

    await runPipeline(makeCtx(), 'hello', [layer1, layer2]);
    expect(calls).toEqual(['layer1', 'layer2']);
  });

  test('passes supplementMode:true to layers after needsSupplement', async () => {
    let receivedSupplementMode: boolean | undefined;

    const layer1: PipelineLayer = async () => ({ handled: true, needsSupplement: true });
    const layer2: PipelineLayer = async (_ctx, _text, extra) => {
      receivedSupplementMode = extra?.supplementMode;
      return { handled: true };
    };

    await runPipeline(makeCtx(), 'hello', [layer1, layer2]);
    expect(receivedSupplementMode).toBe(true);
  });

  test('does not pass supplementMode:true before needsSupplement fires', async () => {
    let receivedBeforeIntent: boolean | undefined;

    const layer1: PipelineLayer = async (_ctx, _text, extra) => {
      receivedBeforeIntent = extra?.supplementMode;
      return { handled: true, needsSupplement: true };
    };

    await runPipeline(makeCtx(), 'hello', [layer1]);
    expect(receivedBeforeIntent).toBeFalsy();
  });

  test('plain handled:true still stops the pipeline', async () => {
    const calls: string[] = [];

    const layer1: PipelineLayer = async () => {
      calls.push('layer1');
      return { handled: true };
    };
    const layer2: PipelineLayer = async () => {
      calls.push('layer2');
      return { handled: true };
    };

    await runPipeline(makeCtx(), 'hello', [layer1, layer2]);
    expect(calls).toEqual(['layer1']); // layer2 not reached
  });
});

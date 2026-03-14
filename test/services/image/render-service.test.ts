import { describe, expect, mock, test } from "bun:test";
import { RenderService } from "../../../src/services/image/render-service.ts";
import { THEME_LIGHT } from "../../../src/worker/templates/themes.ts";
import type { ImageRenderJob } from "../../../src/worker/image-render.queue.ts";

describe("RenderService", () => {
  test("renderDirect enqueues job and decodes base64 result", async () => {
    const pngBase64 = Buffer.from("fake-png-data").toString("base64");
    const mockJob = {
      id: "j1",
      waitUntilFinished: mock(() => Promise.resolve({
        bufferBase64: pngBase64,
        width: 1080, height: 800, renderTimeMs: 500,
      })),
    };
    const mockAdd = mock(() => Promise.resolve(mockJob));
    const mockQueueEvents = {};

    const service = new RenderService(
      { add: mockAdd } as any,
      mockQueueEvents as any,
    );

    const job: ImageRenderJob = {
      type: "daily-agenda",
      data: {
        date: "2026-03-11", dayOfWeek: "Wed", dateFormatted: "March 11",
        eventCount: 0, allDayEvents: [], timedEvents: [],
        theme: THEME_LIGHT, locale: "en",
      },
      userId: 123,
    };

    const result = await service.renderDirect(job);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.toString()).toBe("fake-png-data");
    expect(mockAdd).toHaveBeenCalledTimes(1);
  });
});

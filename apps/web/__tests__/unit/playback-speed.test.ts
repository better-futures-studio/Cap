import { describe, expect, it } from "vitest";
import { formatPlaybackSpeedLabel } from "@/lib/playback-speed";

describe("formatPlaybackSpeedLabel", () => {
	it("trims trailing zeros", () => {
		expect(formatPlaybackSpeedLabel(1)).toBe("1x");
		expect(formatPlaybackSpeedLabel(1.2)).toBe("1.2x");
		expect(formatPlaybackSpeedLabel(1.25)).toBe("1.25x");
		expect(formatPlaybackSpeedLabel(2)).toBe("2x");
		expect(formatPlaybackSpeedLabel(1.5)).toBe("1.5x");
	});

	it("falls back for non-finite rates", () => {
		expect(formatPlaybackSpeedLabel(Number.NaN)).toBe("1x");
		expect(formatPlaybackSpeedLabel(Number.POSITIVE_INFINITY)).toBe("1x");
	});
});

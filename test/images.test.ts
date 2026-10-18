import { describe, expect, it } from "vitest";
import { compressionTarget, scaledSize, withImageExtension, type ImageCompression } from "../src/images";

const options: ImageCompression = {
	enabled: true,
	thresholdBytes: 500 * 1024,
	maxDimension: 2000,
	quality: 0.8,
	format: "keep",
};
const large = 4 * 1024 * 1024;
const everything = () => true;
const noWebp = (mime: string) => mime !== "image/webp";

describe("compressionTarget", () => {
	it("leaves images at or under the limit alone", () => {
		expect(compressionTarget("photo.jpg", 500 * 1024, options, everything)).toBeNull();
		expect(compressionTarget("photo.jpg", 500 * 1024 + 1, options, everything)).toBe("image/jpeg");
	});

	it("does nothing when turned off", () => {
		expect(compressionTarget("photo.jpg", large, { ...options, enabled: false }, everything)).toBeNull();
	});

	it("keeps the original format by default", () => {
		expect(compressionTarget("IMG_0001.JPEG", large, options, everything)).toBe("image/jpeg");
		expect(compressionTarget("shot.png", large, options, everything)).toBe("image/png");
		expect(compressionTarget("pic.webp", large, options, everything)).toBe("image/webp");
	});

	it("skips what cannot be written back in its own format", () => {
		expect(compressionTarget("old.bmp", large, options, everything)).toBeNull();
		expect(compressionTarget("pic.webp", large, options, noWebp)).toBeNull();
	});

	it("never touches animations, vectors or non-images", () => {
		for (const name of ["anim.gif", "logo.svg", "favicon.ico", "clip.mp4", "paper.pdf"]) {
			expect(compressionTarget(name, large, { ...options, format: "jpeg" }, everything)).toBeNull();
		}
	});

	it("converts to the chosen format", () => {
		expect(compressionTarget("shot.png", large, { ...options, format: "jpeg" }, everything)).toBe("image/jpeg");
		expect(compressionTarget("old.bmp", large, { ...options, format: "webp" }, everything)).toBe("image/webp");
	});

	it("falls back to JPEG where WebP cannot be written", () => {
		expect(compressionTarget("shot.png", large, { ...options, format: "webp" }, noWebp)).toBe("image/jpeg");
	});
});

describe("withImageExtension", () => {
	it("swaps the extension for the new format", () => {
		expect(withImageExtension("Pasted image.png", "image/webp")).toBe("Pasted image.webp");
		expect(withImageExtension("shot.PNG", "image/jpeg")).toBe("shot.jpg");
	});

	it("keeps the name when the format is unchanged or nothing is compressed", () => {
		expect(withImageExtension("IMG_0001.jpeg", "image/jpeg")).toBe("IMG_0001.jpeg");
		expect(withImageExtension("photo.png", null)).toBe("photo.png");
	});
});

describe("scaledSize", () => {
	it("fits the longest edge and keeps the proportions", () => {
		expect(scaledSize(4032, 3024, 2000)).toEqual({ width: 2000, height: 1500 });
		expect(scaledSize(3024, 4032, 2000)).toEqual({ width: 1500, height: 2000 });
	});

	it("never enlarges, and 0 means no limit", () => {
		expect(scaledSize(800, 600, 2000)).toEqual({ width: 800, height: 600 });
		expect(scaledSize(4032, 3024, 0)).toEqual({ width: 4032, height: 3024 });
	});
});

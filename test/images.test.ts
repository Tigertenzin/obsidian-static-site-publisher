import { describe, expect, it } from "vitest";
import {
	defaultImageFormat,
	isConvertible,
	replaceExtension,
	scaledSize,
	uploadExtension,
	type ImageDefaults,
} from "../src/images";

const defaults: ImageDefaults = {
	convert: true,
	format: "jpeg",
	quality: 80,
	keepUnderBytes: 500 * 1024,
	maxDimension: 2000,
};
const large = 4 * 1024 * 1024;
const small = 100 * 1024;
const everything = () => true;
const noWebp = (mime: string) => mime !== "image/webp";

describe("isConvertible", () => {
	it("takes still images only", () => {
		for (const name of ["a.jpg", "a.JPEG", "a.png", "a.webp", "a.bmp", "a.avif"]) {
			expect(isConvertible(name)).toBe(true);
		}
		for (const name of ["anim.gif", "logo.svg", "favicon.ico", "clip.mp4", "paper.pdf", "noextension"]) {
			expect(isConvertible(name)).toBe(false);
		}
	});
});

describe("defaultImageFormat", () => {
	it("converts still images to the chosen format, whatever their size", () => {
		expect(defaultImageFormat("shot.png", small, defaults, everything)).toBe("jpeg");
		expect(defaultImageFormat("IMG_0001.jpg", large, defaults, everything)).toBe("jpeg");
		expect(defaultImageFormat("shot.png", small, { ...defaults, format: "webp" }, everything)).toBe("webp");
	});

	it("leaves a small image alone when it is already in the chosen format", () => {
		expect(defaultImageFormat("photo.jpg", 500 * 1024, defaults, everything)).toBe("original");
		expect(defaultImageFormat("photo.jpg", 500 * 1024 + 1, defaults, everything)).toBe("jpeg");
		expect(defaultImageFormat("pic.webp", small, { ...defaults, format: "webp" }, everything)).toBe("original");
	});

	it("never converts GIFs, so they stay animated", () => {
		expect(defaultImageFormat("anim.gif", large, defaults, everything)).toBe("original");
	});

	it("does nothing when turned off", () => {
		expect(defaultImageFormat("shot.png", large, { ...defaults, convert: false }, everything)).toBe("original");
	});

	it("falls back to JPEG where WebP cannot be written", () => {
		expect(defaultImageFormat("shot.png", large, { ...defaults, format: "webp" }, noWebp)).toBe("jpeg");
	});
});

describe("uploadExtension", () => {
	it("follows the format", () => {
		expect(uploadExtension("Shot.PNG", "jpeg")).toBe(".jpg");
		expect(uploadExtension("Shot.PNG", "webp")).toBe(".webp");
		expect(uploadExtension("Shot.PNG", "original")).toBe(".png");
	});

	it("keeps .jpeg rather than renaming it for nothing", () => {
		expect(uploadExtension("IMG_0001.jpeg", "jpeg")).toBe(".jpeg");
	});
});

describe("replaceExtension", () => {
	it("swaps the extension", () => {
		expect(replaceExtension("pasted-image.png", ".webp")).toBe("pasted-image.webp");
		expect(replaceExtension("v1.2-diagram.png", ".jpg")).toBe("v1.2-diagram.jpg");
		expect(replaceExtension("noextension", ".jpg")).toBe("noextension.jpg");
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

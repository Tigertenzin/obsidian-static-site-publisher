import { describe, expect, it } from "vitest";
import {
	ImageProcessor,
	SupersededError,
	defaultImageFormat,
	isConvertible,
	replaceExtension,
	scaledSize,
	uploadExtension,
	type ImageChoice,
	type ImageDefaults,
	type ProcessedImage,
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

describe("ImageProcessor", () => {
	const photo = (path: string) => ({ path, name: path });
	const jpeg = (quality = 80): ImageChoice => ({ format: "jpeg", quality, automatic: true });

	/** A converter that records how many conversions overlap, and can be told to fail. */
	function harness(fail = new Set<string>()) {
		let running = 0;
		let peak = 0;
		const order: string[] = [];
		const convert = async (bytes: ArrayBuffer): Promise<ProcessedImage> => {
			running++;
			peak = Math.max(peak, running);
			await new Promise((resolve) => setTimeout(resolve, 5));
			running--;
			const name = new TextDecoder().decode(bytes);
			order.push(name);
			if (fail.has(name)) throw new Error("cannot draw");
			return { bytes, type: "image/jpeg", width: 1, height: 1, originalWidth: 1, originalHeight: 1, hasAlpha: false };
		};
		const read = async (path: string) => new TextEncoder().encode(path).buffer as ArrayBuffer;
		return { processor: new ImageProcessor(read, 2000, convert), peak: () => peak, order };
	}

	it("converts one image at a time, in the order asked", async () => {
		const { processor, peak, order } = harness();
		await Promise.all(["a.png", "b.png", "c.png"].map((path) => processor.process(photo(path), jpeg())));
		expect(peak()).toBe(1);
		expect(order).toEqual(["a.png", "b.png", "c.png"]);
	});

	it("reuses a finished conversion for the same choice", async () => {
		const { processor, order } = harness();
		const choice = jpeg();
		await processor.process(photo("a.png"), choice);
		expect(processor.finished(photo("a.png"), choice)).not.toBeNull();
		await processor.process(photo("a.png"), choice);
		expect(order).toEqual(["a.png"]);
		expect(processor.finished(photo("a.png"), jpeg(50))).toBeNull();
	});

	it("skips a conversion overtaken by a newer choice before its turn", async () => {
		const { processor, order } = harness();
		const first = processor.process(photo("a.png"), jpeg());
		const stale = processor.process(photo("b.png"), jpeg(80));
		const latest = processor.process(photo("b.png"), jpeg(50));
		await first;
		await expect(stale).rejects.toBeInstanceOf(SupersededError);
		await latest;
		expect(order).toEqual(["a.png", "b.png"]);
	});

	it("does not remember a failure, so trying again tries again", async () => {
		const fail = new Set(["a.png"]);
		const { processor, order } = harness(fail);
		await expect(processor.process(photo("a.png"), jpeg())).rejects.toThrow("cannot draw");
		fail.clear();
		await expect(processor.process(photo("a.png"), jpeg())).resolves.toBeTruthy();
		expect(order).toEqual(["a.png", "a.png"]);
	});

	it("keeps going after a failure", async () => {
		const { processor } = harness(new Set(["a.png"]));
		const failed = processor.process(photo("a.png"), jpeg());
		const next = processor.process(photo("b.png"), jpeg());
		await expect(failed).rejects.toThrow();
		await expect(next).resolves.toBeTruthy();
	});
});

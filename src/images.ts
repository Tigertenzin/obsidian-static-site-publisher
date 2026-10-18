/** What an oversized image is re-encoded as. */
export type CompressedFormat = "keep" | "jpeg" | "webp";

export interface ImageCompression {
	enabled: boolean;
	/** Images at or below this many bytes are uploaded as they are. */
	thresholdBytes: number;
	/** Longest edge, in pixels, an image is scaled down to. 0 leaves the size alone. */
	maxDimension: number;
	/** Encoder quality, 0 to 1. A PNG ignores it. */
	quality: number;
	format: CompressedFormat;
}

const MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	bmp: "image/bmp",
};

const EXTENSIONS: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/**
 * Types a browser can decode reliably and that are worth re-encoding. GIFs are
 * left alone, since a canvas would keep only the first frame, as are SVGs,
 * which are already small and scale on their own.
 */
const COMPRESSIBLE = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp"]);

export function imageMimeType(name: string): string | null {
	const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
	return match ? MIME_TYPES[match[1]] ?? null : null;
}

/**
 * The type an image will be re-encoded as, or null when it is uploaded as it
 * is. Decided from the file's name and size alone, before its bytes are read,
 * so the review window can show the name it will be uploaded under.
 * `canEncode` says whether this device can write a type; WebP falls back to
 * JPEG where it cannot.
 */
export function compressionTarget(
	name: string,
	size: number,
	options: ImageCompression,
	canEncode: (mime: string) => boolean
): string | null {
	if (!options.enabled || size <= options.thresholdBytes) return null;

	const input = imageMimeType(name);
	if (input === null || !COMPRESSIBLE.has(input)) return null;

	if (options.format === "jpeg") return "image/jpeg";
	if (options.format === "webp") return canEncode("image/webp") ? "image/webp" : "image/jpeg";

	// Keeping the format: a BMP cannot be written back, and a WebP only where the device can.
	if (!(input in EXTENSIONS) || !canEncode(input)) return null;
	return input;
}

/** A filename with the extension of the type it will be uploaded as. */
export function withImageExtension(name: string, mime: string | null): string {
	const extension = mime === null ? undefined : EXTENSIONS[mime];
	if (extension === undefined) return name;

	// A .jpeg stays .jpeg rather than being renamed to .jpg for no reason.
	if (imageMimeType(name) === mime) return name;

	const at = name.lastIndexOf(".");
	return `${at === -1 ? name : name.slice(0, at)}.${extension}`;
}

/** Scales a size down, keeping its proportions, so neither edge exceeds `max`. */
export function scaledSize(width: number, height: number, max: number): { width: number; height: number } {
	const longest = Math.max(width, height);
	if (max <= 0 || longest <= max) return { width, height };

	const scale = max / longest;
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

const encodable = new Map<string, boolean>();

/** Whether this device's canvas can write a type. Safari, for one, cannot write WebP everywhere. */
export function canEncode(mime: string): boolean {
	let known = encodable.get(mime);
	if (known === undefined) {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 1;
		// An unsupported type quietly comes back as a PNG.
		known = canvas.toDataURL(mime).startsWith(`data:${mime}`);
		encodable.set(mime, known);
	}
	return known;
}

/**
 * Re-encodes an image as `outputType`, scaled down to fit the maximum size. The
 * image is decoded by an <img>, which honours the EXIF rotation phone cameras
 * write, so a portrait photo stays upright once that tag is gone.
 */
export async function compressImage(
	bytes: ArrayBuffer,
	inputType: string,
	outputType: string,
	options: ImageCompression
): Promise<ArrayBuffer> {
	const url = URL.createObjectURL(new Blob([bytes], { type: inputType }));
	try {
		const image = new Image();
		image.src = url;
		await image.decode();
		return await encode(image, outputType, options);
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function encode(image: HTMLImageElement, outputType: string, options: ImageCompression): Promise<ArrayBuffer> {
	const { width, height } = scaledSize(image.naturalWidth, image.naturalHeight, options.maxDimension);

	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("this device cannot draw images");

	// JPEG has no transparency; without a fill, transparent areas turn black.
	if (outputType === "image/jpeg") {
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, width, height);
	}
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	context.drawImage(image, 0, 0, width, height);

	const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, options.quality));
	if (!blob || blob.type !== outputType) throw new Error(`this device cannot write ${outputType}`);
	return blob.arrayBuffer();
}

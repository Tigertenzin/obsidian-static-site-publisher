/**
 * What an image is uploaded as. "original" sends the vault file untouched; the
 * others scale it down and re-encode it.
 */
export type ImageFormat = "original" | "jpeg" | "webp";

/** The format the settings convert to, which every image starts out with. */
export type ConvertFormat = Exclude<ImageFormat, "original">;

export interface ImageDefaults {
	convert: boolean;
	format: ConvertFormat;
	/** Encoder quality, 1 to 100. */
	quality: number;
	/** An image already in the chosen format and no bigger than this is left as it is. */
	keepUnderBytes: number;
	/** Longest edge, in pixels, a converted image is scaled down to. 0 leaves the size alone. */
	maxDimension: number;
}

/** How one image will be uploaded. Shared by every embed of the same file, and edited in place. */
export interface ImageChoice {
	format: ImageFormat;
	quality: number;
	/**
	 * True while the format is the one the settings picked, so the review window
	 * may correct it once it has seen the image: a default that would lose
	 * transparency or grow the file is not what anyone meant. A choice made by
	 * hand is left alone.
	 */
	automatic: boolean;
}

/** An image as it will be uploaded, with what it was before. */
export interface ProcessedImage {
	bytes: ArrayBuffer;
	type: string;
	width: number;
	height: number;
	originalWidth: number;
	originalHeight: number;
	/** Whether the image has see-through areas, which JPEG cannot keep. */
	hasAlpha: boolean;
}

const MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	webp: "image/webp",
	bmp: "image/bmp",
	avif: "image/avif",
	gif: "image/gif",
	svg: "image/svg+xml",
	ico: "image/x-icon",
};

const FORMAT_TYPES: Record<ConvertFormat, string> = {
	jpeg: "image/jpeg",
	webp: "image/webp",
};

/**
 * Still images a browser decodes reliably. GIFs are left out, since a canvas
 * keeps only the first frame and the animation would be lost, as are SVGs,
 * which are already small and scale on their own.
 */
const CONVERTIBLE = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/avif"]);

export function imageMimeType(name: string): string | null {
	return MIME_TYPES[extensionOf(name).slice(1).toLowerCase()] ?? null;
}

export function isConvertible(name: string): boolean {
	const type = imageMimeType(name);
	return type !== null && CONVERTIBLE.has(type);
}

export function formatMimeType(format: ConvertFormat): string {
	return FORMAT_TYPES[format];
}

/**
 * The format an image starts out with in the review window. Decided from its
 * name and size alone, before its bytes are read, so the window can show the
 * name it will be uploaded under straight away. `canEncode` says whether this
 * device can write a type; WebP falls back to JPEG where it cannot.
 */
export function defaultImageFormat(
	name: string,
	size: number,
	defaults: ImageDefaults,
	canEncode: (mime: string) => boolean
): ImageFormat {
	if (!defaults.convert || !isConvertible(name)) return "original";

	const format = defaults.format === "webp" && !canEncode("image/webp") ? "jpeg" : defaults.format;
	// Re-encoding a small image that is already in the right format only loses quality.
	if (imageMimeType(name) === formatMimeType(format) && size <= defaults.keepUnderBytes) return "original";
	return format;
}

/** The extension, with its dot, of the file an image is uploaded as. */
export function uploadExtension(sourceName: string, format: ImageFormat): string {
	const own = extensionOf(sourceName).toLowerCase();
	if (format === "original") return own;
	// A .jpeg stays .jpeg rather than being renamed to .jpg for no reason.
	if (format === "jpeg") return own === ".jpeg" ? own : ".jpg";
	return ".webp";
}

/** A filename with its extension swapped for another. */
export function replaceExtension(name: string, extension: string): string {
	const own = extensionOf(name);
	return `${own.length > 0 ? name.slice(0, -own.length) : name}${extension}`;
}

function extensionOf(name: string): string {
	const match = name.match(/\.[a-z0-9]+$/i);
	return match ? match[0] : "";
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
 * Converts images for upload, one result kept per file, so the review window's
 * previews and the upload itself share a single conversion of each image.
 */
export class ImageProcessor {
	private reads = new Map<string, Promise<ArrayBuffer>>();
	private results = new Map<string, { key: string; result: Promise<ProcessedImage> }>();

	constructor(
		private readonly read: (path: string) => Promise<ArrayBuffer>,
		private readonly maxDimension: number
	) {}

	/** The vault file's bytes, read once. */
	original(path: string): Promise<ArrayBuffer> {
		let bytes = this.reads.get(path);
		if (!bytes) {
			bytes = this.read(path);
			this.reads.set(path, bytes);
		}
		return bytes;
	}

	process(file: { path: string; name: string }, choice: ImageChoice): Promise<ProcessedImage> {
		const key = `${choice.format}:${choice.quality}`;
		const cached = this.results.get(file.path);
		if (cached?.key === key) return cached.result;

		const inputType = imageMimeType(file.name) ?? "application/octet-stream";
		const outputType = choice.format === "original" ? null : formatMimeType(choice.format);
		const result = this.original(file.path).then((bytes) =>
			processImage(bytes, inputType, outputType, choice.quality / 100, this.maxDimension)
		);
		// Only the latest choice is worth keeping: dragging the quality slider
		// would otherwise hold on to every setting it passed through.
		this.results.set(file.path, { key, result });
		return result;
	}
}

/**
 * Scales an image down to fit `maxDimension` and re-encodes it as `outputType`,
 * or, with no output type, only reads its size. The image is decoded by an
 * <img>, which honours the EXIF rotation phone cameras write, so a portrait
 * photo stays upright once that tag is gone.
 */
export async function processImage(
	bytes: ArrayBuffer,
	inputType: string,
	outputType: string | null,
	quality: number,
	maxDimension: number
): Promise<ProcessedImage> {
	const url = URL.createObjectURL(new Blob([bytes], { type: inputType }));
	try {
		const image = new Image();
		image.src = url;
		await image.decode();

		const originalWidth = image.naturalWidth;
		const originalHeight = image.naturalHeight;
		const hasAlpha = inputType !== "image/jpeg" && CONVERTIBLE.has(inputType) && hasTransparency(image);

		if (outputType === null) {
			return { bytes, type: inputType, width: originalWidth, height: originalHeight, originalWidth, originalHeight, hasAlpha };
		}

		const { width, height } = scaledSize(originalWidth, originalHeight, maxDimension);
		const canvas = drawCanvas(width, height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("this device cannot draw images");

		// JPEG has no transparency; without a fill, see-through areas turn black.
		if (outputType === "image/jpeg") {
			context.fillStyle = "#ffffff";
			context.fillRect(0, 0, width, height);
		}
		context.imageSmoothingEnabled = true;
		context.imageSmoothingQuality = "high";
		context.drawImage(image, 0, 0, width, height);

		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outputType, quality));
		if (!blob || blob.type !== outputType) throw new Error(`this device cannot write ${outputType}`);

		return { bytes: await blob.arrayBuffer(), type: outputType, width, height, originalWidth, originalHeight, hasAlpha };
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Checks a small copy for any pixel that is not fully opaque. */
function hasTransparency(image: HTMLImageElement): boolean {
	const { width, height } = scaledSize(image.naturalWidth, image.naturalHeight, 256);
	const canvas = drawCanvas(width, height);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) return false;

	context.drawImage(image, 0, 0, width, height);
	const pixels = context.getImageData(0, 0, width, height).data;
	for (let i = 3; i < pixels.length; i += 4) {
		if (pixels[i] < 255) return true;
	}
	return false;
}

function drawCanvas(width: number, height: number): HTMLCanvasElement {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

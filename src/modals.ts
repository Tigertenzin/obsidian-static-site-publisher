import {
	App,
	ButtonComponent,
	DropdownComponent,
	ExtraButtonComponent,
	Modal,
	Notice,
	Setting,
	TextAreaComponent,
	TextComponent,
	ToggleComponent,
	stringifyYaml,
} from "obsidian";
import { attachmentUrl, cleanAttachmentName, mediaKind, type Embed, type MediaKind } from "./attachments";
import { diffLines, type DiffLine, type DiffResult } from "./diff";
import { TextSuggest } from "./suggest";
import type { NoteLink } from "./syntax";
import type { VaultIndex } from "./vault";
import type { RemoteFile } from "./github";
import { PROPERTY_TYPE_LABELS, type PropertyType } from "./settings";
import {
	convertValue,
	normaliseFileName,
	parseValue,
	valueToInput,
	type BreakResult,
	type EditableType,
	type OutgoingProperty,
	type PropertyOrigin,
} from "./transform";

/** Above this, an image is worth flagging before it is committed. */
const LARGE_ATTACHMENT = 5 * 1024 * 1024;

/** What the alt text field means for each kind of embed, since only images have alt text. */
const ALT_FIELDS: Record<MediaKind, { label: string; placeholder: string }> = {
	image: { label: "Alt text", placeholder: "describe the image" },
	video: { label: "Label", placeholder: "optional, read out by screen readers" },
	audio: { label: "Label", placeholder: "optional, read out by screen readers" },
	document: { label: "Link text", placeholder: "defaults to the file name" },
};

const ORIGIN_LABELS: Record<PropertyOrigin, string> = {
	note: "from note",
	settings: "from settings",
	manual: "added here",
};

/** An embed paired with the vault file it points at and how it will be published. */
export interface Attachment {
	embed: Embed;
	/** The vault file, or null when the link resolves to nothing. */
	file: { name: string; path: string } | null;
	/** Filename inside the repository's attachment folder. Edited in place. */
	fileName: string;
	/** Alt text for the published embed. Edited in place. */
	alt: string;
	/** Size of the vault file in bytes, 0 when it could not be found. */
	size: number;
	missing: boolean;
	/** The vault file's name, with the extension of the format it is uploaded in. */
	uploadName: string;
	/** The type the image is compressed to before uploading, or null when it is sent as it is. */
	compressTo: string | null;
}

/** Whether an attachment is already in the repository as it stands in the vault. */
export type UploadStatus = "new" | "changed" | "unchanged";

/** One file to be committed alongside the post, checked against the repository. */
export interface PlannedUpload {
	/** Full path inside the repository. */
	path: string;
	fileName: string;
	bytes: ArrayBuffer;
	/** Size of the vault file, which differs from the bytes when the image was compressed. */
	originalSize: number;
	/** SHA of what is at the path now, or null when nothing is. */
	remoteSha: string | null;
	status: UploadStatus;
}

const UPLOAD_STATUS_LABELS: Record<UploadStatus, string> = {
	new: "new",
	changed: "changed",
	unchanged: "unchanged, skipped",
};

export interface ReviewContext {
	/** Vault path of the note being published. */
	sourcePath: string;
	/** Filename inside the repository, edited in place by the review window. */
	fileName: string;
	/** True when the filename is the one this note was last published under. */
	fileNameRemembered: boolean;
	repoLabel: string;
	branch: string;
	/** Turns the filename as typed into the full path inside the repository. */
	resolvePath: (fileName: string) => string;
	/**
	 * Where an image is put, relative to the attachment folder. Follows the post's
	 * filename as it currently stands, since images may be grouped by post.
	 */
	attachmentPath: (attachmentName: string) => string;
	/** Reads whatever is at a path, cached per path across both windows. */
	lookup: (path: string) => Promise<RemoteFile | null>;
	/** Drops a cached lookup, so the next one reads the path from GitHub again. */
	forget: (path: string) => void;
	/** Every property the published copy will carry. Edited in place. */
	properties: OutgoingProperty[];
	/** Properties the settings stripped, offered back for restoring. Edited in place. */
	removed: OutgoingProperty[];
	/** Images embedded in the published portion of the note. Edited in place. */
	attachments: Attachment[];
	attachmentUrlPrefix: string;
	breakResult: BreakResult;
	/** The body to publish: cut at the break, with comments already removed when asked. */
	body: string;
	/** Links to other notes that will be published as plain text. */
	noteLinks: NoteLink[];
	frontmatterError: string | null;
	/** Property names and values already used in the vault, for autocomplete. */
	index: VaultIndex;
}

/**
 * First step: the complete frontmatter of the published copy, laid out for editing.
 * The settings decide what this starts as; everything here can be changed, added
 * to, or dropped for this one publish.
 */
export class ReviewModal extends Modal {
	private listEl!: HTMLElement;
	private removedEl!: HTMLElement;
	private pathEl!: HTMLElement;
	private destinationEl!: HTMLElement;
	/** Key of the row whose name field should take focus after the next render. */
	private focusKeyOf: OutgoingProperty | null = null;
	/** Guards against a slow destination check overwriting a newer one. */
	private lookupSeq = 0;
	private lookupTimer: number | null = null;
	private suggests: TextSuggest[] = [];
	/** Redraws each image's published URL, which moves when the post is renamed. */
	private urlRenderers: Array<() => void> = [];

	constructor(
		app: App,
		private readonly context: ReviewContext,
		private readonly onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ssp-modal");

		contentEl.createEl("h2", { text: "Publish note" });

		const summary = contentEl.createDiv({ cls: "ssp-summary" });
		summary
			.createDiv({ cls: "ssp-summary-row" })
			.append(createLabel("Note"), createValue(this.context.sourcePath));
		summary
			.createDiv({ cls: "ssp-summary-row" })
			.append(createLabel("Repository"), createValue(`${this.context.repoLabel} · ${this.context.branch}`));

		this.renderFileName(summary);

		if (this.context.frontmatterError) {
			contentEl.createDiv({
				cls: "ssp-warning",
				text: `The note's frontmatter could not be read (${this.context.frontmatterError}). It will be replaced by the properties below.`,
			});
		}

		contentEl.createEl("h3", { text: "Properties" });
		contentEl.createEl("p", {
			cls: "ssp-hint",
			text: "These are the properties the published copy will carry. Editing them here changes only what is sent — the note in your vault is untouched.",
		});
		this.listEl = contentEl.createDiv({ cls: "ssp-property-list" });

		new Setting(contentEl).setClass("ssp-add-row").addButton((button) =>
			button.setButtonText("Add property").onClick(() => {
				const property: OutgoingProperty = { key: "", type: "text", value: null, origin: "manual" };
				this.context.properties.push(property);
				this.focusKeyOf = property;
				this.refresh();
			})
		);

		this.removedEl = contentEl.createDiv();

		this.renderAttachments(contentEl);

		this.destinationEl = contentEl.createDiv({ cls: "ssp-destination" });
		this.runLookup();

		this.renderBreakWarning(contentEl);
		this.renderNoteLinks(contentEl);

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Continue to preview")
					.setCta()
					.onClick(() => {
						const problem = this.validate();
						if (problem) {
							new Notice(problem, 6000);
							return;
						}
						this.close();
						this.onConfirm();
					})
			);

		this.refresh();
	}

	/** The filename the post is published under, editable before publishing. */
	private renderFileName(summary: HTMLElement): void {
		const row = summary.createDiv({ cls: "ssp-summary-row" });
		row.append(createLabel("Filename"));

		const input = new TextComponent(row)
			.setPlaceholder("post-name.md")
			.setValue(this.context.fileName)
			.onChange((value) => {
				this.context.fileName = value;
				this.renderPath();
				for (const render of this.urlRenderers) render();
				// The destination depends on the name, so re-check it as it settles.
				this.scheduleLookup();
			});
		input.inputEl.addClass("ssp-filename-input");
		if (this.context.fileNameRemembered) {
			row.createSpan({ cls: "ssp-origin", text: "as last published" });
		}

		this.pathEl = summary.createDiv({ cls: "ssp-summary-row ssp-path-row" });
		this.renderPath();
	}

	private renderPath(): void {
		const path = this.context.resolvePath(this.context.fileName);
		this.pathEl.empty();
		this.pathEl.append(createLabel("Publishes to"), createValue(path || "—"));
	}

	/** Re-checks the destination a moment after typing stops. */
	private scheduleLookup(): void {
		if (this.lookupTimer !== null) window.clearTimeout(this.lookupTimer);
		this.lookupTimer = window.setTimeout(() => {
			this.lookupTimer = null;
			this.runLookup();
		}, 400);
	}

	/** Reports whether the target path is already taken, once GitHub answers. */
	private runLookup(): void {
		const container = this.destinationEl;
		const path = this.context.resolvePath(this.context.fileName);
		const seq = ++this.lookupSeq;

		container.removeClass("ssp-destination-exists", "ssp-warning");
		container.addClass("ssp-checking");
		container.setText("Checking the repository…");

		if (path.length === 0) {
			container.removeClass("ssp-checking");
			container.addClass("ssp-warning");
			container.setText("Give the file a name before publishing.");
			return;
		}

		this.context
			.lookup(path)
			.then((remote) => {
				if (seq !== this.lookupSeq || !container.isConnected) return;
				container.removeClass("ssp-checking");
				if (remote) {
					container.addClass("ssp-destination-exists");
					container.setText(
						"A file already exists at this path. You will see a diff and a separate confirmation before it is overwritten."
					);
				} else {
					container.setText("Nothing at this path yet — this will create a new file.");
				}
			})
			.catch((error: Error) => {
				if (seq !== this.lookupSeq || !container.isConnected) return;
				container.removeClass("ssp-checking");
				container.addClass("ssp-warning");
				container.setText(`Could not check the destination: ${error.message}`);
			});
	}

	/** Images and other media found in the note, with the name and alt text they publish under. */
	private renderAttachments(contentEl: HTMLElement): void {
		const attachments = this.context.attachments;
		if (attachments.length === 0) return;

		const onlyImages = attachments.every((a) => mediaKind(a.embed.linkpath) === "image");
		contentEl.createEl("h3", { text: onlyImages ? "Images" : "Attachments" });
		contentEl.createEl("p", {
			cls: "ssp-hint",
			text: "Embeds in the published part of the note. Each is uploaded to the repository and its link rewritten to point there.",
		});

		const missing = attachments.filter((a) => a.missing);
		if (missing.length > 0) {
			contentEl.createDiv({
				cls: "ssp-warning",
				text: `${missing.length} embed${missing.length === 1 ? "" : "s"} could not be found in the vault. ${
					missing.length === 1 ? "It" : "They"
				} will be left exactly as written.`,
			});
		}

		const list = contentEl.createDiv({ cls: "ssp-property-list" });

		// Embeds of the same vault file share one upload, so their names move together.
		const namesByFile = new Map<string, Array<{ attachment: Attachment; input: TextComponent; showUrl: () => void }>>();

		for (const attachment of attachments) {
			const row = list.createDiv({ cls: "ssp-property" });
			const head = row.createDiv({ cls: "ssp-property-head" });

			head.createSpan({ cls: "ssp-attachment-source", text: attachment.embed.linkpath });
			if (attachment.embed.width !== null) {
				head.createSpan({ cls: "ssp-origin", text: `${attachment.embed.width}px` });
			}
			head.createSpan({
				cls: attachment.missing ? "ssp-attachment-missing" : "ssp-origin",
				text: attachment.missing ? "not found" : formatBytes(attachment.size),
			});

			if (attachment.missing) continue;

			if (attachment.compressTo !== null) {
				const format = attachment.compressTo.replace("image/", "").toUpperCase();
				row.createDiv({
					cls: "ssp-hint",
					text: `Over the compression limit: it will be scaled down and saved as ${format} before uploading. The image in the vault is not changed.`,
				});
			} else if (attachment.size > LARGE_ATTACHMENT) {
				row.createDiv({
					cls: "ssp-warning",
					text: `${formatBytes(
						attachment.size
					)} is large for a web page, and GitHub may refuse to commit it. Consider shrinking it in the vault first.`,
				});
			}

			const nameRow = row.createDiv({ cls: "ssp-attachment-field" });
			nameRow.createSpan({ cls: "ssp-label", text: "Name" });
			const name = new TextComponent(nameRow);
			name.inputEl.addClass("ssp-value-input");

			const altRow = row.createDiv({ cls: "ssp-attachment-field" });
			const altField = ALT_FIELDS[mediaKind(attachment.embed.linkpath) ?? "image"];
			altRow.createSpan({ cls: "ssp-label", text: altField.label });
			const alt = new TextComponent(altRow)
				.setPlaceholder(altField.placeholder)
				.setValue(attachment.alt)
				.onChange((value) => {
					attachment.alt = value;
				});
			alt.inputEl.addClass("ssp-value-input");

			const urlEl = row.createDiv({ cls: "ssp-attachment-url" });
			const showUrl = () =>
				urlEl.setText(
					attachmentUrl(this.context.attachmentUrlPrefix, this.context.attachmentPath(attachment.fileName))
				);
			this.urlRenderers.push(showUrl);

			const filePath = attachment.file?.path ?? "";
			const siblings = namesByFile.get(filePath) ?? [];
			siblings.push({ attachment, input: name, showUrl });
			namesByFile.set(filePath, siblings);

			if (siblings.length > 1) {
				head.createSpan({ cls: "ssp-origin", text: "same image as above" });
			}

			const originalName = attachment.uploadName;
			name.setValue(attachment.fileName).onChange((value) => {
				// The URL shows the cleaned name as it is typed; the field itself is
				// only tidied on blur, so the cursor is not yanked mid-word.
				const cleaned = cleanAttachmentName(value, originalName);
				for (const sibling of siblings) {
					sibling.attachment.fileName = cleaned;
					if (sibling.input !== name) sibling.input.setValue(cleaned);
					sibling.showUrl();
				}
			});
			name.inputEl.addEventListener("blur", () => name.setValue(attachment.fileName));
			showUrl();
		}
	}

	/**
	 * Shows what the break marker cuts. The default marker is a horizontal rule,
	 * which is common mid-note, so the amount being dropped is spelled out.
	 */
	private renderBreakWarning(contentEl: HTMLElement): void {
		const result = this.context.breakResult;

		// A "---" under a line of text is a heading underline, so it did not cut;
		// say so, in case it was meant as the break.
		if (result.headingUnderlines.length > 0) {
			const lines = result.headingUnderlines.map((line) => line + 1);
			const many = lines.length > 1;
			contentEl.createDiv({
				cls: "ssp-note",
				text: `The break marker on body line${many ? "s" : ""} ${lines.join(", ")} sit${many ? "" : "s"} directly under a line of text, so markdown reads ${many ? "them" : "it"} as a heading underline and ${many ? "they were" : "it was"} not treated as a break. Put a blank line above a marker you meant as the break.`,
			});
		}

		if (!result.trimmed) return;

		const heavy = result.droppedLines > result.keptLines;
		const box = contentEl.createDiv({ cls: heavy ? "ssp-warning" : "ssp-note" });

		box.createDiv({
			cls: "ssp-break-headline",
			text: `Break marker on body line ${result.markerLine + 1}: ${result.droppedLines} of ${
				result.keptLines + result.droppedLines
			} lines will be left out.`,
		});

		if (heavy) {
			box.createDiv({
				cls: "ssp-break-headline",
				text: "That is more than half the note — check the marker is where you meant it.",
			});
		}

		const details = box.createEl("details", { cls: "ssp-break-details" });
		details.createEl("summary", { text: "Show what will be dropped" });
		const pre = details.createEl("pre", { cls: "ssp-preview ssp-break-preview" });
		pre.createEl("code", { text: result.dropped });
	}

	/**
	 * Links to other notes have nowhere to point on the site, so they are published
	 * as plain text. Listed in full, in case one was meant to link to a page there.
	 */
	private renderNoteLinks(contentEl: HTMLElement): void {
		const links = this.context.noteLinks;
		if (links.length === 0) return;

		const box = contentEl.createDiv({ cls: "ssp-warning" });
		box.createDiv({
			cls: "ssp-break-headline",
			text: `${links.length} link${links.length === 1 ? "" : "s"} to other notes will be published as plain text. If any should link to a page on your site, replace ${links.length === 1 ? "it" : "them"} with a regular link in the note.`,
		});

		const details = box.createEl("details", { cls: "ssp-break-details" });
		details.createEl("summary", { text: "Show the links" });
		const list = details.createEl("ul", { cls: "ssp-removed-list" });
		for (const link of links) {
			list.createEl("li", { text: `${link.raw} → ${link.text}` });
		}
	}

	private refresh(): void {
		this.renderProperties();
		this.renderRemoved();

		if (this.focusKeyOf) {
			const index = this.context.properties.indexOf(this.focusKeyOf);
			const input = this.listEl.querySelectorAll<HTMLInputElement>(".ssp-key-input")[index];
			input?.focus();
			this.focusKeyOf = null;
		}
	}

	/** Blocks the step forward on duplicate property keys or image names, which would silently lose one. */
	private validate(): string | null {
		if (normaliseFileName(this.context.fileName).length === 0) {
			return "Give the file a name before publishing.";
		}

		// Two different images under one name would share one upload, and one
		// of them would silently show the other's picture.
		const imageNames = new Map<string, string>();
		for (const attachment of this.context.attachments) {
			if (attachment.file === null || attachment.fileName.length === 0) continue;
			const other = imageNames.get(attachment.fileName);
			if (other !== undefined && other !== attachment.file.path) {
				return `Two different images are both named "${attachment.fileName}". Rename one before continuing.`;
			}
			imageNames.set(attachment.fileName, attachment.file.path);
		}

		const seen = new Set<string>();
		for (const property of this.context.properties) {
			const key = property.key.trim();
			if (key.length === 0) continue;
			if (seen.has(key)) {
				return `Two properties are both named "${key}". Rename or remove one before continuing.`;
			}
			seen.add(key);
		}
		return null;
	}

	private renderProperties(): void {
		for (const suggest of this.suggests) suggest.destroy();
		this.suggests.length = 0;
		this.listEl.empty();

		if (this.context.properties.length === 0) {
			this.listEl.createEl("p", {
				cls: "ssp-empty-state",
				text: "The published copy will have no frontmatter.",
			});
			return;
		}

		this.context.properties.forEach((property, index) => {
			this.renderRow(property, index);
		});
	}

	private renderRow(property: OutgoingProperty, index: number): void {
		const row = this.listEl.createDiv({ cls: "ssp-property" });
		const head = row.createDiv({ cls: "ssp-property-head" });

		const key = new TextComponent(head)
			.setPlaceholder("property name")
			.setValue(property.key)
			.onChange((value) => {
				property.key = value;
			});
		key.inputEl.addClass("ssp-key-input");
		// Names already in the vault, minus the ones this note is already writing.
		this.suggest(key.inputEl, () =>
			this.context.index.names.filter(
				(name) =>
					name === property.key ||
					!this.context.properties.some((other) => other !== property && other.key === name)
			)
		);

		const dropdown = new DropdownComponent(head);
		for (const [value, label] of Object.entries(PROPERTY_TYPE_LABELS)) {
			dropdown.addOption(value, label);
		}
		if (property.type === "object") {
			// Nested YAML has no editor here, so the row is passed through as it stands.
			dropdown.addOption("object", "Nested value");
			dropdown.setDisabled(true);
		}
		dropdown.setValue(property.type).onChange((value) => {
			const nextType = value as EditableType;
			property.value = convertValue(property, nextType);
			property.type = nextType;
			this.refresh();
		});

		head.createSpan({ cls: "ssp-origin", text: ORIGIN_LABELS[property.origin] });

		new ExtraButtonComponent(head)
			.setIcon("trash-2")
			.setTooltip("Leave this property out of the published copy")
			.onClick(() => {
				this.context.properties.splice(index, 1);
				this.refresh();
			});

		this.renderValue(row.createDiv({ cls: "ssp-property-value" }), property);
	}

	private renderValue(container: HTMLElement, property: OutgoingProperty): void {
		if (property.type === "object") {
			const pre = container.createEl("pre", { cls: "ssp-object-value" });
			pre.createEl("code", { text: stringifyYaml(property.rawValue ?? null).trimEnd() });
			return;
		}

		const current = valueToInput(property.value, property.type);

		switch (property.type) {
			case "checkbox":
				new ToggleComponent(container).setValue(property.value === true).onChange((value) => {
					property.value = value;
				});
				return;

			case "number": {
				const text = new TextComponent(container).setValue(current).onChange((value) => {
					property.value = parseValue(value, "number");
				});
				text.inputEl.type = "number";
				text.inputEl.addClass("ssp-value-input");
				return;
			}

			case "list": {
				const textarea = new TextAreaComponent(container)
					.setPlaceholder("one value per line")
					.setValue(current)
					.onChange((value) => {
						property.value = parseValue(value, "list");
					});
				textarea.inputEl.rows = 3;
				textarea.inputEl.addClass("ssp-value-input");
				this.renderValueChips(container, property);
				return;
			}

			case "date":
			case "datetime": {
				const type = property.type;
				// Only use the native picker when the value fits its format, so an
				// unusual value from the note is never silently blanked out.
				const fitsPicker = current.length === 0 || matchesNativeFormat(current, type);
				const text = new TextComponent(container).setValue(current).onChange((value) => {
					property.value = parseValue(value, type);
				});
				if (fitsPicker) text.inputEl.type = type === "date" ? "date" : "datetime-local";
				text.inputEl.addClass("ssp-value-input");
				return;
			}

			default: {
				const text = new TextComponent(container).setValue(current).onChange((value) => {
					property.value = parseValue(value, "text");
				});
				text.inputEl.addClass("ssp-value-input");
				this.suggest(text.inputEl, () => this.context.index.valuesFor(property.key));
			}
		}
	}

	/**
	 * A list is edited as a textarea, where a dropdown would fight with typing.
	 * Values already used for this property are offered as chips to click instead.
	 */
	private renderValueChips(container: HTMLElement, property: OutgoingProperty): void {
		const known = this.context.index.valuesFor(property.key);
		if (known.length === 0) return;

		const textarea = container.querySelector("textarea");
		if (!(textarea instanceof HTMLTextAreaElement)) return;

		const chips = container.createDiv({ cls: "ssp-chips" });

		const render = () => {
			chips.empty();
			const current = new Set(Array.isArray(property.value) ? property.value : []);
			const available = known.filter((value) => !current.has(value)).slice(0, 12);
			if (available.length === 0) return;

			chips.createSpan({ cls: "ssp-chips-label", text: "Add:" });
			for (const value of available) {
				const chip = chips.createEl("button", { cls: "ssp-chip", text: value });
				chip.type = "button";
				chip.onclick = () => {
					const next = [...(Array.isArray(property.value) ? property.value : []), value];
					property.value = next;
					textarea.value = next.join("\n");
					render();
				};
			}
		};

		render();
	}

	/** Attaches autocomplete to an input and keeps it for cleanup. */
	private suggest(
		input: HTMLInputElement,
		source: (query: string) => string[] | Promise<string[]>
	): void {
		this.suggests.push(new TextSuggest(input, source));
	}

	private renderRemoved(): void {
		this.removedEl.empty();

		if (this.context.removed.length === 0) return;

		this.removedEl.createEl("h3", { text: "Removed by settings" });
		this.removedEl.createEl("p", {
			cls: "ssp-hint",
			text: "Present in the note, stripped from the published copy. Restore one to publish it this time.",
		});

		this.context.removed.forEach((property, index) => {
			const row = this.removedEl.createDiv({ cls: "ssp-removed-row" });
			row.createSpan({ cls: "ssp-removed-key", text: property.key });
			row.createSpan({
				cls: "ssp-removed-value",
				text: property.type === "object" ? "nested value" : valueToInput(property.value, property.type),
			});

			new ExtraButtonComponent(row)
				.setIcon("rotate-ccw")
				.setTooltip("Restore this property")
				.onClick(() => {
					this.context.removed.splice(index, 1);
					this.context.properties.push(property);
					this.refresh();
				});
		});
	}

	onClose(): void {
		if (this.lookupTimer !== null) window.clearTimeout(this.lookupTimer);
		for (const suggest of this.suggests) suggest.destroy();
		this.suggests.length = 0;
		this.contentEl.empty();
	}
}

export interface PreviewOptions {
	targetPath: string;
	repoLabel: string;
	branch: string;
	output: string;
	/** The file currently at the target path, or null when the path is free. */
	remote: RemoteFile | null;
	/** Set when the destination lookup failed, so the diff could not be built. */
	remoteError: string | null;
	/** True when the file at the target path already matches the output exactly. */
	postUnchanged: boolean;
	/** Each attachment checked against the repository, or null when that check failed. */
	uploads: PlannedUpload[] | null;
	/** Why the attachments could not be checked. */
	uploadsError: string | null;
	onBack: () => void;
	onPublish: () => Promise<void>;
}

/**
 * Second step: the exact markdown that will be committed. When something is already
 * at the target path it opens on a diff against that file, and publishing goes
 * through a separate overwrite confirmation.
 */
export class PreviewModal extends Modal {
	private readonly diff: DiffResult | null;
	private view: "diff" | "document";
	private bodyEl!: HTMLElement;

	constructor(app: App, private readonly options: PreviewOptions) {
		super(app);

		const remote = options.remote;
		this.diff = remote && !remote.tooLarge ? diffLines(remote.content, options.output) : null;
		// Default to whichever view answers the question the user actually has.
		this.view = hasLineChanges(this.diff) ? "diff" : "document";
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ssp-modal");

		// Replacing the post is what warrants a warning and a second confirmation;
		// an unchanged post is left alone, whatever happens to its images.
		const overwriting = this.options.remote !== null && !this.options.postUnchanged;
		contentEl.createEl("h2", { text: overwriting ? "Review changes" : "Preview" });
		contentEl.createDiv({
			cls: "ssp-summary-row",
			text: `${this.options.repoLabel} · ${this.options.branch} · ${this.options.targetPath}`,
		});

		this.renderStatus(contentEl);
		this.renderAttachmentSummary(contentEl);
		this.renderViewSwitch(contentEl);
		this.bodyEl = contentEl.createDiv();
		this.renderBody();
		this.renderButtons(contentEl, overwriting);
	}

	private renderStatus(contentEl: HTMLElement): void {
		if (this.options.remoteError) {
			contentEl.createDiv({
				cls: "ssp-warning",
				text: `The destination could not be checked (${this.options.remoteError}). Publishing may overwrite an existing file without showing you a diff.`,
			});
			return;
		}

		if (!this.options.remote) {
			contentEl.createDiv({ cls: "ssp-note", text: "This will create a new file." });
			return;
		}

		if (this.options.remote.tooLarge) {
			contentEl.createDiv({
				cls: "ssp-warning",
				text: "A file already exists here but is too large for GitHub to return inline, so it cannot be diffed. Publishing will replace it.",
			});
			return;
		}

		if (this.options.postUnchanged) {
			const pending = this.pendingUploads();
			let text = "The post is identical to the file already in the repository and will be left as is.";
			if (this.nothingToPublish()) {
				text = "Nothing to publish: the post and its attachments are already up to date in the repository.";
			} else if (this.options.uploads !== null) {
				text += ` Only the ${pending} new or changed attachment${pending === 1 ? "" : "s"} below will be uploaded.`;
			}
			contentEl.createDiv({ cls: "ssp-note", text });
			return;
		}

		if (this.diff?.whitespaceOnly) {
			contentEl.createDiv({
				cls: "ssp-note",
				text: "No line differs from the file in the repository — only its line endings or trailing newline. Publishing will still rewrite the file.",
			});
			return;
		}

		const stats = contentEl.createDiv({ cls: "ssp-warning" });
		stats.setText("This will overwrite the file already at this path. ");
		stats.createSpan({ cls: "ssp-stat-add", text: `+${this.diff?.added ?? 0}` });
		stats.createSpan({ text: " " });
		stats.createSpan({ cls: "ssp-stat-remove", text: `−${this.diff?.removed ?? 0}` });

		if (this.diff?.coarse) {
			contentEl.createDiv({
				cls: "ssp-hint",
				text: "The documents differ too much to match up line by line, so the whole file is shown as replaced.",
			});
		}
	}

	/** Lists the attachments with what will happen to each. */
	private renderAttachmentSummary(contentEl: HTMLElement): void {
		if (this.options.uploadsError) {
			contentEl.createDiv({
				cls: "ssp-warning",
				text: `The attachments could not be checked against the repository (${this.options.uploadsError}). Publishing checks them again, and stops if it still cannot.`,
			});
			return;
		}

		const uploads = this.options.uploads ?? [];
		if (uploads.length === 0) return;

		const pending = this.pendingUploads();
		const noun = uploads.every((upload) => mediaKind(upload.path) === "image") ? "image" : "attachment";
		const box = contentEl.createDiv({ cls: "ssp-note" });
		box.createDiv({
			text:
				pending === 0
					? `All ${uploads.length} ${noun}${uploads.length === 1 ? " is" : "s are"} already in the repository unchanged:`
					: `${pending} ${noun}${pending === 1 ? "" : "s"} will be committed together with the post, in one commit:`,
		});
		const list = box.createEl("ul", { cls: "ssp-removed-list" });
		for (const upload of uploads) {
			const item = list.createEl("li", { text: `${upload.path} ` });
			if (upload.bytes.byteLength !== upload.originalSize) {
				item.createSpan({
					cls: "ssp-origin",
					text: `compressed ${formatBytes(upload.originalSize)} → ${formatBytes(upload.bytes.byteLength)}`,
				});
				item.appendText(" ");
			}
			item.createSpan({ cls: "ssp-origin", text: UPLOAD_STATUS_LABELS[upload.status] });
		}
	}

	/** How many checked attachments will actually be committed. */
	private pendingUploads(): number {
		return (this.options.uploads ?? []).filter((upload) => upload.status !== "unchanged").length;
	}

	/** True only when it is certain that publishing would change nothing at all. */
	private nothingToPublish(): boolean {
		return this.options.postUnchanged && this.options.uploads !== null && this.pendingUploads() === 0;
	}

	private renderViewSwitch(contentEl: HTMLElement): void {
		if (!hasLineChanges(this.diff)) return;

		const switcher = contentEl.createDiv({ cls: "ssp-view-switch" });
		const options: Array<{ id: "diff" | "document"; label: string }> = [
			{ id: "diff", label: "Changes" },
			{ id: "document", label: "Full document" },
		];

		for (const option of options) {
			const button = switcher.createEl("button", { text: option.label });
			button.toggleClass("is-active", this.view === option.id);
			button.onclick = () => {
				this.view = option.id;
				switcher.findAll("button").forEach((el) => el.removeClass("is-active"));
				button.addClass("is-active");
				this.renderBody();
			};
		}
	}

	private renderBody(): void {
		this.bodyEl.empty();

		if (this.view === "diff" && hasLineChanges(this.diff)) {
			this.renderDiff(this.bodyEl);
			return;
		}

		const pre = this.bodyEl.createEl("pre", { cls: "ssp-preview" });
		pre.createEl("code", { text: this.options.output });

		if (this.options.output.trim().length === 0) {
			this.bodyEl.createDiv({
				cls: "ssp-warning",
				text: "The published copy would be empty. Check the break marker and property settings.",
			});
		}
	}

	private renderDiff(container: HTMLElement): void {
		const pre = container.createEl("pre", { cls: "ssp-preview ssp-diff" });

		for (const line of this.diff?.lines ?? []) {
			pre.createDiv({ cls: `ssp-diff-line ssp-diff-${line.type}`, text: diffLineText(line) });
		}
	}

	private renderButtons(contentEl: HTMLElement, overwriting: boolean): void {
		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Back").onClick(() => {
					this.close();
					this.options.onBack();
				})
			)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => {
				if (this.nothingToPublish()) {
					button.setButtonText("Nothing to publish").setDisabled(true);
					return;
				}
				button.setButtonText(overwriting ? "Overwrite…" : "Publish").setCta();
				if (overwriting) button.setWarning();
				button.onClick(() => {
					if (!overwriting) {
						void this.runPublish(button);
						return;
					}
					new ConfirmOverwriteModal(this.app, {
						targetPath: this.options.targetPath,
						repoLabel: this.options.repoLabel,
						branch: this.options.branch,
						diff: this.diff,
						onConfirm: async () => {
							await this.options.onPublish();
							this.close();
						},
					}).open();
				});
			});
	}

	private async runPublish(button: ButtonComponent): Promise<void> {
		button.setDisabled(true);
		button.setButtonText("Publishing…");
		try {
			await this.options.onPublish();
			this.close();
		} catch {
			// Already reported in a notice; the window stays open so the user can go Back.
		} finally {
			button.setDisabled(false);
			button.setButtonText("Publish");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Third step, only when a file is being replaced: confirm the overwrite. */
export class ConfirmOverwriteModal extends Modal {
	constructor(
		app: App,
		private readonly options: {
			targetPath: string;
			repoLabel: string;
			branch: string;
			diff: DiffResult | null;
			onConfirm: () => Promise<void>;
		}
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ssp-modal");

		contentEl.createEl("h2", { text: "Overwrite this file?" });

		contentEl.createEl("p", {
			text: `${this.options.targetPath} in ${this.options.repoLabel} on branch ${this.options.branch} will be replaced by the version you just reviewed.`,
		});

		const diff = this.options.diff;
		if (hasLineChanges(diff)) {
			const stats = contentEl.createEl("p", { cls: "ssp-summary-row" });
			stats.createSpan({ cls: "ssp-stat-add", text: `+${diff.added}` });
			stats.createSpan({ text: " " });
			stats.createSpan({ cls: "ssp-stat-remove", text: `−${diff.removed}` });
			stats.createSpan({ text: " lines" });
		}

		contentEl.createEl("p", {
			cls: "ssp-hint",
			text: "Nothing is committed if the post or any of its attachments has changed on GitHub since it was read.",
		});

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Overwrite")
					.setWarning()
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Publishing…");
						try {
							await this.options.onConfirm();
						} catch {
							// Already reported in a notice. Closing returns to the preview,
							// whose Back button is how a conflict is resolved.
						} finally {
							button.setDisabled(false);
							button.setButtonText("Overwrite");
							this.close();
						}
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** True when the diff has something worth rendering as added and removed lines. */
function hasLineChanges(diff: DiffResult | null): diff is DiffResult {
	return diff !== null && !diff.identical && !diff.whitespaceOnly;
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

function diffLineText(line: DiffLine): string {
	switch (line.type) {
		case "add":
			return `+ ${line.text}`;
		case "remove":
			return `- ${line.text}`;
		case "gap":
			return `⋯ ${line.text}`;
		default:
			return `  ${line.text}`;
	}
}

function createLabel(text: string): HTMLElement {
	const el = createSpan({ cls: "ssp-label" });
	el.setText(text);
	return el;
}

function createValue(text: string): HTMLElement {
	const el = createSpan({ cls: "ssp-value" });
	el.setText(text);
	return el;
}

function matchesNativeFormat(value: string, type: PropertyType): boolean {
	return type === "date"
		? /^\d{4}-\d{2}-\d{2}$/.test(value)
		: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value);
}

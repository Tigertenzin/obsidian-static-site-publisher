import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { ImageSizeStyle } from "./attachments";
import type { ConvertFormat, ImageDefaults } from "./images";
import type { HighlightStyle, NoteLinkStyle } from "./syntax";
import type StaticSitePublisherPlugin from "./main";
import { TextSuggest } from "./suggest";
import { buildVaultIndex, type VaultIndex } from "./vault";

/** Property value types, mirroring Obsidian's own property types. */
export type PropertyType = "text" | "number" | "checkbox" | "date" | "datetime" | "list";

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
	text: "Text",
	number: "Number",
	checkbox: "Checkbox",
	date: "Date",
	datetime: "Date & time",
	list: "List",
};

/** A property the plugin writes into the published copy of a note. */
export interface AddedProperty {
	key: string;
	type: PropertyType;
	/** Prefilled in the review window when the note has no value of its own. */
	defaultValue: string;
	/** When the note already has this property, keep its value instead of the default. */
	keepExistingValue: boolean;
}

export interface StaticSitePublisherSettings {
	// GitHub connection
	owner: string;
	repo: string;
	branch: string;
	/**
	 * Name of the secret in Obsidian's secret storage that holds the access token.
	 * The token itself is never written to the plugin's data.
	 */
	tokenSecret: string;
	targetFolder: string;
	/** The filename a note is first offered under, with {{placeholders}}. */
	fileNameTemplate: string;
	preserveFolderStructure: boolean;
	commitMessageTemplate: string;

	// Property transforms
	propertiesToAdd: AddedProperty[];
	propertiesToRemove: string[];

	// Content transform
	breakEnabled: boolean;
	breakMarker: string;

	// Obsidian syntax
	noteLinkStyle: NoteLinkStyle;
	stripComments: boolean;
	highlightStyle: HighlightStyle;

	// Attachments
	uploadAttachments: boolean;
	attachmentFolder: string;
	/** Keep each post's images in a subfolder named after the post. */
	groupAttachmentsByPost: boolean;
	attachmentUrlPrefix: string;
	imageSizeStyle: ImageSizeStyle;
	/** Convert still images to a web format before uploading them. Each can be changed in the review window. */
	convertImages: boolean;
	imageFormat: ConvertFormat;
	/** Encoder quality for converted images, from 1 to 100. */
	imageQuality: number;
	/** An image already in the chosen format and no bigger than this many kilobytes is left as it is. */
	keepImagesUnderKb: number;
	/** Longest edge, in pixels, a converted image is scaled down to. 0 keeps its size. */
	maxImageDimension: number;

	/**
	 * The filename each note was last published under, by vault path, so a
	 * republish goes back to the same file. Not shown in the settings tab.
	 */
	publishedFileNames: Record<string, string>;
}

export const DEFAULT_SETTINGS: StaticSitePublisherSettings = {
	owner: "",
	repo: "",
	branch: "main",
	tokenSecret: "",
	targetFolder: "",
	fileNameTemplate: "{{slug}}.md",
	preserveFolderStructure: false,
	commitMessageTemplate: "Publish {{filename}}",

	propertiesToAdd: [],
	propertiesToRemove: [],

	breakEnabled: true,
	breakMarker: "---",

	noteLinkStyle: "text",
	stripComments: true,
	highlightStyle: "mark",

	uploadAttachments: true,
	attachmentFolder: "posts/attachments",
	groupAttachmentsByPost: true,
	attachmentUrlPrefix: "/posts/attachments",
	imageSizeStyle: "html",
	convertImages: true,
	imageFormat: "jpeg",
	imageQuality: 80,
	keepImagesUnderKb: 500,
	maxImageDimension: 2000,

	publishedFileNames: {},
};

/** The image settings in the form the image module takes them. */
export function imageDefaults(settings: StaticSitePublisherSettings): ImageDefaults {
	return {
		convert: settings.convertImages,
		format: settings.imageFormat === "webp" ? "webp" : "jpeg",
		quality: Math.min(Math.max(Math.round(settings.imageQuality), 1), 100),
		keepUnderBytes: settings.keepImagesUnderKb * 1024,
		maxDimension: settings.maxImageDimension,
	};
}

/** What the placeholders are, for the settings that take them. */
const PLACEHOLDER_HELP =
	"{{title}}, {{slug}}, {{date}}, {{time}} and {{datetime}}; dates take a format, as {{date:MMMM D, YYYY}}.";

export class StaticSitePublisherSettingTab extends PluginSettingTab {
	plugin: StaticSitePublisherPlugin;
	private index: VaultIndex = { names: [], valuesFor: () => [] };
	private suggests: TextSuggest[] = [];
	/** Repository folders, fetched once per settings visit when first needed. */
	private folders: Promise<string[]> | null = null;

	constructor(app: App, plugin: StaticSitePublisherPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		this.teardownSuggests();
		containerEl.empty();

		this.index = buildVaultIndex(this.app);
		this.folders = null;

		this.renderSetup(containerEl);
		this.renderConnection(containerEl);
		this.renderPropertiesToAdd(containerEl);
		this.renderPropertiesToRemove(containerEl);
		this.renderContentBreak(containerEl);
		this.renderSyntax(containerEl);
		this.renderAttachments(containerEl);
	}

	hide(): void {
		this.teardownSuggests();
	}

	private teardownSuggests(): void {
		for (const suggest of this.suggests) suggest.destroy();
		this.suggests.length = 0;
	}

	/** Attaches autocomplete to an input and keeps it for cleanup. */
	private suggest(
		input: HTMLInputElement,
		source: (query: string) => string[] | Promise<string[]>
	): void {
		this.suggests.push(new TextSuggest(input, source));
	}

	/**
	 * Folder names in the repository, loaded lazily and reused. A failed load is
	 * not kept, so focusing the field again — say, once the token is in — retries.
	 */
	private repoFolders(): Promise<string[]> {
		if (!this.folders) {
			const pending = this.plugin
				.github()
				.listFolders()
				.catch(() => {
					if (this.folders === pending) this.folders = null;
					return [];
				});
			this.folders = pending;
		}
		return this.folders;
	}

	private async save() {
		await this.plugin.saveSettings();
	}

	/**
	 * There is no sign-in handshake here — the whole connection is a key the user
	 * creates on GitHub and pastes in. Saying so plainly, in the place where they
	 * are about to do it, is worth more than any amount of documentation.
	 */
	private renderSetup(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Setting up").setHeading();

		const intro = containerEl.createDiv({ cls: "ssp-setup" });
		intro.createEl("p", {
			text: "There is no “sign in with GitHub” step. Instead you create a key on GitHub that opens one repository, and paste it in below. The plugin shows that key to GitHub each time it publishes; that is the whole connection.",
		});

		const steps = intro.createEl("ol", { cls: "ssp-setup-steps" });

		const create = steps.createEl("li");
		create.createSpan({ text: "On GitHub, create a " });
		create.createEl("strong", { text: "fine-grained personal access token" });
		create.createSpan({
			text: ". Give it an expiry date. Under Repository access choose Only select repositories and pick your site's repository. Under Permissions set Contents to Read and write — that is all this plugin needs.",
		});

		steps.createEl("li", {
			text: "Under Personal access token below, create a secret, paste the token into it, and fill in the repository owner and name.",
		});
		steps.createEl("li", { text: "Press Test. It checks the token can reach both the repository and the branch." });

		new Setting(containerEl)
			.setName("Create a token on GitHub")
			.setDesc("Opens GitHub's fine-grained token page in your browser.")
			.addButton((button) =>
				button
					.setButtonText("Open GitHub")
					.setCta()
					.onClick(() => window.open("https://github.com/settings/personal-access-tokens/new", "_blank"))
			);

		// Folded away: true and worth reading once, but not what someone setting
		// the plugin up for the first time needs in front of them.
		const notes = containerEl.createEl("details", { cls: "ssp-details" });
		notes.createEl("summary", { text: "Where the token is kept, and how to disconnect" });
		notes.createEl("p", {
			text: "The token is kept in Obsidian's secret storage, which belongs to this device rather than to your vault: the plugin's settings only record the secret's name. A backup, a sync service or a git repository that copies your vault does not copy the token — which also means that on each other device you publish from, you set the token once in these settings.",
		});
		notes.createEl("p", {
			text: "You can revoke the token on GitHub at any time and the plugin stops working immediately; there is nothing to disconnect here. The token is only ever sent to api.github.com, is never written into a note or a commit, and is kept out of any error message the plugin shows you.",
		});

		new Setting(containerEl)
			.setName("Manage or revoke your tokens")
			.setDesc("Opens the list of tokens on your GitHub account.")
			.addButton((button) =>
				button
					.setButtonText("Open GitHub")
					.onClick(() => window.open("https://github.com/settings/tokens?type=beta", "_blank"))
			);
	}

	private renderConnection(containerEl: HTMLElement) {
		new Setting(containerEl).setName("GitHub connection").setHeading();

		new Setting(containerEl)
			.setName("Repository owner")
			.setDesc("GitHub user or organisation that owns the repository.")
			.addText((text) =>
				text
					.setPlaceholder("octocat")
					.setValue(this.plugin.settings.owner)
					.onChange(async (value) => {
						this.plugin.settings.owner = value.trim();
						// The folder list belongs to the old connection.
						this.folders = null;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Repository name")
			.addText((text) =>
				text
					.setPlaceholder("my-blog")
					.setValue(this.plugin.settings.repo)
					.onChange(async (value) => {
						this.plugin.settings.repo = value.trim();
						// The folder list belongs to the old connection.
						this.folders = null;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("Branch the note is committed to.")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim();
						// The folder list belongs to the old connection.
						this.folders = null;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"A fine-grained token limited to this one repository, with Contents: read and write — nothing else is needed. Choose or create the secret that holds it; the token is kept in Obsidian's secret storage on this device, never in your vault."
			)
			.addComponent((el) =>
				new SecretComponent(this.app, el).setValue(this.plugin.settings.tokenSecret).onChange(async (value) => {
					this.plugin.settings.tokenSecret = value;
					// The folder list belongs to the old connection.
					this.folders = null;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Target folder")
			.setDesc(
				"Folder inside the repository to publish into. Focus the field to browse the folders that exist on the branch. Leave empty for the repository root."
			)
			.addText((text) => {
				text
					.setPlaceholder("content/posts")
					.setValue(this.plugin.settings.targetFolder)
					.onChange(async (value) => {
						this.plugin.settings.targetFolder = value.trim();
						await this.save();
					});
				this.suggest(text.inputEl, () => this.repoFolders());
			});

		new Setting(containerEl)
			.setName("Default filename")
			.setDesc(
				`The filename a note is first offered under in the review window, where it can still be changed. After that, a note is offered the filename it was last published under. Supports ${PLACEHOLDER_HELP}`
			)
			.addText((text) =>
				text
					.setPlaceholder("{{slug}}.md")
					.setValue(this.plugin.settings.fileNameTemplate)
					.onChange(async (value) => {
						this.plugin.settings.fileNameTemplate = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Mirror vault folder structure")
			.setDesc("Append the note's folder path inside the vault to the target folder.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.preserveFolderStructure).onChange(async (value) => {
					this.plugin.settings.preserveFolderStructure = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Commit message")
			.setDesc(`Supports {{path}}, the file's path in the repository, as well as ${PLACEHOLDER_HELP}`)
			.addText((text) =>
				text
					.setPlaceholder("Publish {{filename}}")
					.setValue(this.plugin.settings.commitMessageTemplate)
					.onChange(async (value) => {
						this.plugin.settings.commitMessageTemplate = value;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Check that the token can reach the repository and branch.")
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Testing…");
					try {
						const info = await this.plugin.github().checkConnection();
						new Notice(`Connected to ${info.fullName} (branch ${info.branch}).`);
					} catch (error) {
						new Notice(`Connection failed: ${(error as Error).message}`, 8000);
					} finally {
						button.setDisabled(false);
						button.setButtonText("Test");
					}
				})
			);
	}

	private renderPropertiesToAdd(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Properties to add")
			.setDesc(
				`Written into the published copy. You confirm or edit each value in the review window before publishing. Default values support ${PLACEHOLDER_HELP}`
			)
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Add property")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.propertiesToAdd.push({
							key: "",
							type: "text",
							defaultValue: "",
							keepExistingValue: true,
						});
						await this.save();
						this.display();
					})
			);

		if (this.plugin.settings.propertiesToAdd.length === 0) {
			containerEl.createEl("p", {
				text: "No properties configured yet.",
				cls: "ssp-empty-state",
			});
		}

		this.plugin.settings.propertiesToAdd.forEach((property, index) => {
			const setting = new Setting(containerEl)
				.setClass("ssp-property-row")
				.addText((text) => {
					text
						.setPlaceholder("property name")
						.setValue(property.key)
						.onChange(async (value) => {
							property.key = value.trim();
							await this.save();
						});
					this.suggest(text.inputEl, () => this.index.names);
				})
				.addDropdown((dropdown) => {
					for (const [value, label] of Object.entries(PROPERTY_TYPE_LABELS)) {
						dropdown.addOption(value, label);
					}
					dropdown.setValue(property.type).onChange(async (value) => {
						property.type = value as PropertyType;
						await this.save();
						this.display();
					});
				})
				.addText((text) => {
					text
						.setPlaceholder(defaultValuePlaceholder(property.type))
						.setValue(property.defaultValue)
						.onChange(async (value) => {
							property.defaultValue = value;
							await this.save();
						});
					this.suggest(text.inputEl, () =>
						property.key.length > 0 ? this.index.valuesFor(property.key) : []
					);
				});

			setting.addToggle((toggle) =>
				toggle
					.setTooltip("Keep the note's own value when it already has this property")
					.setValue(property.keepExistingValue)
					.onChange(async (value) => {
						property.keepExistingValue = value;
						await this.save();
					})
			);

			setting.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Remove")
					.onClick(async () => {
						this.plugin.settings.propertiesToAdd.splice(index, 1);
						await this.save();
						this.display();
					})
			);
		});

		containerEl.createEl("p", {
			text: "Columns: name · type · default value · keep existing value.",
			cls: "ssp-hint",
		});
	}

	private renderPropertiesToRemove(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Properties to remove")
			.setDesc("Stripped from the published copy when the note carries them.")
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Add property")
					.setCta()
					.onClick(async () => {
						this.plugin.settings.propertiesToRemove.push("");
						await this.save();
						this.display();
					})
			);

		if (this.plugin.settings.propertiesToRemove.length === 0) {
			containerEl.createEl("p", {
				text: "No properties configured yet.",
				cls: "ssp-empty-state",
			});
			return;
		}

		this.plugin.settings.propertiesToRemove.forEach((name, index) => {
			new Setting(containerEl)
				.setClass("ssp-property-row")
				.addText((text) => {
					text
						.setPlaceholder("property name")
						.setValue(name)
						.onChange(async (value) => {
							this.plugin.settings.propertiesToRemove[index] = value.trim();
							await this.save();
						});
					text.inputEl.addClass("ssp-remove-input");
					// Suggest what the vault actually uses, minus what is already listed.
					this.suggest(text.inputEl, () =>
						this.index.names.filter(
							(candidate) =>
								candidate === this.plugin.settings.propertiesToRemove[index] ||
								!this.plugin.settings.propertiesToRemove.includes(candidate)
						)
					);
				})
				.addExtraButton((button) =>
					button
						.setIcon("trash-2")
						.setTooltip("Remove")
						.onClick(async () => {
							this.plugin.settings.propertiesToRemove.splice(index, 1);
							await this.save();
							this.display();
						})
				);
		});
	}

	private renderContentBreak(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Content break").setHeading();

		new Setting(containerEl)
			.setName("Trim content after a break")
			.setDesc("Everything from the first break marker onwards is left out of the published copy.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.breakEnabled).onChange(async (value) => {
					this.plugin.settings.breakEnabled = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Break marker")
			.setDesc("Matched against a whole line, ignoring surrounding whitespace. Defaults to a horizontal rule.")
			.addText((text) =>
				text
					.setPlaceholder("---")
					.setValue(this.plugin.settings.breakMarker)
					.onChange(async (value) => {
						this.plugin.settings.breakMarker = value;
						await this.save();
					})
			);
	}

	private renderSyntax(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Obsidian syntax").setHeading();

		new Setting(containerEl)
			.setName("Links to other notes")
			.setDesc(
				"[[Wikilinks]], note embeds and markdown links to .md files point at notes the site does not have. The review window lists every one it converts."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("text", "Publish as plain text")
					.addOption("keep", "Leave as written")
					.setValue(this.plugin.settings.noteLinkStyle)
					.onChange(async (value) => {
						this.plugin.settings.noteLinkStyle = value as NoteLinkStyle;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Remove comments")
			.setDesc("Leave %%comments%% out of the published copy, inline or spanning several lines.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.stripComments).onChange(async (value) => {
					this.plugin.settings.stripComments = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Highlights")
			.setDesc("How ==highlighted text== is published.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("mark", "As a <mark> tag")
					.addOption("strip", "As plain text")
					.addOption("keep", "Leave as written")
					.setValue(this.plugin.settings.highlightStyle)
					.onChange(async (value) => {
						this.plugin.settings.highlightStyle = value as HighlightStyle;
						await this.save();
					})
			);
	}

	private renderAttachments(containerEl: HTMLElement) {
		new Setting(containerEl).setName("Attachments").setHeading();

		new Setting(containerEl)
			.setName("Upload embedded images")
			.setDesc(
				"Find images embedded in the note, upload them to the repository, and rewrite the embeds to point at the uploaded copies."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.uploadAttachments).onChange(async (value) => {
					this.plugin.settings.uploadAttachments = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Attachment folder")
			.setDesc(
				"Folder inside the repository that uploaded images are committed to. Focus the field to browse existing folders."
			)
			.addText((text) => {
				text
					.setPlaceholder("posts/attachments")
					.setValue(this.plugin.settings.attachmentFolder)
					.onChange(async (value) => {
						this.plugin.settings.attachmentFolder = value.trim();
						await this.save();
					});
				this.suggest(text.inputEl, () => this.repoFolders());
			});

		new Setting(containerEl)
			.setName("Group images by post")
			.setDesc(
				"Put each post's images in a subfolder of the attachment folder named after the post, so images from different posts that share a filename cannot overwrite each other. Off puts every image straight into the attachment folder."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.groupAttachmentsByPost).onChange(async (value) => {
					this.plugin.settings.groupAttachmentsByPost = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Attachment URL prefix")
			.setDesc(
				"What the rewritten embeds point at. Usually the attachment folder with a leading slash, since the site serves it from the root."
			)
			.addText((text) =>
				text
					.setPlaceholder("/posts/attachments")
					.setValue(this.plugin.settings.attachmentUrlPrefix)
					.onChange(async (value) => {
						this.plugin.settings.attachmentUrlPrefix = value.trim();
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Image sizes")
			.setDesc(
				"Obsidian writes a size as ![[image.png|450]], which markdown has no way to express."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("html", "Keep, as an <img width> tag")
					.addOption("drop", "Drop, use plain markdown")
					.setValue(this.plugin.settings.imageSizeStyle)
					.onChange(async (value) => {
						this.plugin.settings.imageSizeStyle = value as ImageSizeStyle;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Convert images")
			.setDesc(
				"Convert still images to a web format before uploading them, scaled down and compressed, so photos straight from a phone camera do not weigh several megabytes. GIFs and SVGs are always uploaded as they are, so animations keep moving. Each image's format and quality can still be changed in the review window, and the image in the vault is never changed."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.convertImages).onChange(async (value) => {
					this.plugin.settings.convertImages = value;
					await this.save();
				})
			);

		new Setting(containerEl)
			.setName("Image format")
			.setDesc(
				"What images are converted to. JPEG works on every device; WebP is smaller and keeps transparency, but some devices, Safari on older iPhones among them, cannot write it and fall back to JPEG."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("jpeg", "JPEG")
					.addOption("webp", "WebP")
					.setValue(this.plugin.settings.imageFormat)
					.onChange(async (value) => {
						this.plugin.settings.imageFormat = value as ConvertFormat;
						await this.save();
					})
			);

		new Setting(containerEl)
			.setName("Image quality")
			.setDesc("The quality images start out with in the review window. Lower is smaller.")
			.addSlider((slider) =>
				slider
					.setLimits(10, 100, 5)
					.setValue(this.plugin.settings.imageQuality)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.imageQuality = value;
						await this.save();
					})
			);

		this.renderNumber(containerEl, {
			name: "Maximum width or height (px)",
			desc: "A converted image is scaled down until its longest edge fits. 0 keeps its full size.",
			placeholder: "2000",
			get: () => this.plugin.settings.maxImageDimension,
			set: (value) => (this.plugin.settings.maxImageDimension = value),
		});

		this.renderNumber(containerEl, {
			name: "Leave small images alone (KB)",
			desc: "An image already in the chosen format and no bigger than this is uploaded as it is, rather than re-encoded and losing a little quality for nothing.",
			placeholder: "500",
			get: () => this.plugin.settings.keepImagesUnderKb,
			set: (value) => (this.plugin.settings.keepImagesUnderKb = value),
		});
	}

	/** A whole-number setting; anything that is not one is ignored until it is. */
	private renderNumber(
		containerEl: HTMLElement,
		field: { name: string; desc: string; placeholder: string; get: () => number; set: (value: number) => void }
	) {
		new Setting(containerEl)
			.setName(field.name)
			.setDesc(field.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text
					.setPlaceholder(field.placeholder)
					.setValue(String(field.get()))
					.onChange(async (value) => {
						const parsed = Number(value.trim());
						if (value.trim().length === 0 || !Number.isInteger(parsed) || parsed < 0) return;
						field.set(parsed);
						await this.save();
					});
			});
	}
}

function defaultValuePlaceholder(type: PropertyType): string {
	switch (type) {
		case "number":
			return "0";
		case "checkbox":
			return "false";
		case "date":
			return "2026-09-04";
		case "datetime":
			return "2026-09-04T09:00";
		case "list":
			return "one, two";
		default:
			return "default value";
	}
}

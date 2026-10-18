import { MarkdownView, Notice, Plugin, TFile, normalizePath } from "obsidian";
import {
	attachmentUrl,
	findEmbeds,
	postAttachmentFolder,
	renderEmbed,
	rewriteBody,
	sanitiseAttachmentName,
} from "./attachments";
import { canEncode, compressImage, compressionTarget, imageMimeType, withImageExtension } from "./images";
import { GithubClient, gitBlobSha, type CommitFile, type FolderListing, type RemoteFile } from "./github";
import {
	PreviewModal,
	ReviewModal,
	type Attachment,
	type PlannedUpload,
	type ReviewContext,
} from "./modals";
import {
	DEFAULT_SETTINGS,
	StaticSitePublisherSettingTab,
	imageCompression,
	type StaticSitePublisherSettings,
} from "./settings";
import { expandPlaceholders } from "./placeholders";
import { convertHighlights, findNoteLinks, noteLinksToText, stripComments } from "./syntax";
import { buildVaultIndex } from "./vault";
import {
	applyBreak,
	buildOutput,
	buildTargetPath,
	defaultFileName,
	normaliseFileName,
	parseNote,
	postRelativePath,
	resolveProperties,
} from "./transform";

export default class StaticSitePublisherPlugin extends Plugin {
	settings: StaticSitePublisherSettings = DEFAULT_SETTINGS;
	private client!: GithubClient;

	async onload() {
		await this.loadSettings();
		this.client = new GithubClient(
			() => this.settings,
			() => this.accessToken()
		);

		this.addCommand({
			id: "publish-current-note",
			name: "Publish current note",
			checkCallback: (checking: boolean) => {
				const file = this.activeMarkdownFile();
				if (!file) return false;
				if (!checking) void this.startPublish(file);
				return true;
			},
		});

		this.addSettingTab(new StaticSitePublisherSettingTab(this.app, this));

		// The remembered filenames are keyed by vault path, so they follow the note.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				const remembered = this.settings.publishedFileNames[oldPath];
				if (remembered === undefined) return;
				delete this.settings.publishedFileNames[oldPath];
				this.settings.publishedFileNames[file.path] = remembered;
				void this.saveSettings();
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file.path in this.settings.publishedFileNames)) return;
				delete this.settings.publishedFileNames[file.path];
				void this.saveSettings();
			})
		);
	}

	github(): GithubClient {
		return this.client;
	}

	async loadSettings() {
		// A deep copy, so the lists the settings tab edits in place are never the
		// defaults' own: a fresh install would otherwise be editing DEFAULT_SETTINGS.
		let saved = await this.loadData();
		const imported = saved === null || saved === undefined ? await this.formerPluginData() : null;
		if (imported) saved = imported;
		this.settings = Object.assign(structuredClone(DEFAULT_SETTINGS), saved);

		// Earlier versions always published under the note's own name. Keep that for
		// an existing install, or every republish would land as a second copy under
		// the new slugged name; new installs get the slug.
		if (saved && typeof saved === "object" && !("fileNameTemplate" in saved)) {
			this.settings.fileNameTemplate = "{{title}}.md";
		}

		await this.migrateToken();

		// Older versions stored the removal list as one newline-joined string.
		const removals = this.settings.propertiesToRemove as unknown;
		if (typeof removals === "string") {
			this.settings.propertiesToRemove = removals
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		}

		if (imported) {
			await this.saveSettings();
			new Notice(
				"Static Site Publisher imported your settings from Publish to GitHub, its former name. You can now uninstall Publish to GitHub, and re-assign any hotkey you had for publishing.",
				15000
			);
		}
	}

	/**
	 * The plugin was called Publish to GitHub, with the id "publish-to-github", and
	 * its settings live in that plugin's own folder. A first load under the new id
	 * reads them from there, so nothing has to be set up again. Null when there is
	 * nothing to import.
	 */
	private async formerPluginData(): Promise<unknown> {
		const path = normalizePath(`${this.app.vault.configDir}/plugins/${FORMER_PLUGIN_ID}/data.json`);
		try {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const data: unknown = JSON.parse(await this.app.vault.adapter.read(path));
			return data && typeof data === "object" ? data : null;
		} catch {
			return null;
		}
	}

	/**
	 * The token from secret storage — or, if moving it there failed, the copy still
	 * in data.json, so publishing keeps working until the move succeeds.
	 */
	private accessToken(): string | null {
		const secret = this.settings.tokenSecret ? this.app.secretStorage.getSecret(this.settings.tokenSecret) : null;
		if (secret) return secret;
		const legacy = (this.settings as { token?: unknown }).token;
		return typeof legacy === "string" && legacy.trim().length > 0 ? legacy.trim() : null;
	}

	/**
	 * Brings the token under this plugin's own secret name. Versions before 0.2.0
	 * kept the token itself in data.json; 0.2.x kept it in secret storage under the
	 * former name. Either way it is copied into secret storage as
	 * "static-site-publisher-token" and the settings point there. The old copy is
	 * let go only once the new one is confirmed to read back; if anything goes wrong
	 * it stays where it was, keeps working, and the move is tried again on the next
	 * load. (A secret cannot be deleted by a plugin, so the old one is left in place
	 * for the old plugin, until you remove it in Obsidian's settings.)
	 */
	private async migrateToken(): Promise<void> {
		const settings = this.settings as StaticSitePublisherSettings & { token?: unknown };
		const storage = this.app.secretStorage;

		const plaintext = typeof settings.token === "string" ? settings.token.trim() : "";
		const formerSecret =
			settings.tokenSecret === FORMER_TOKEN_SECRET_ID ? storage.getSecret(FORMER_TOKEN_SECRET_ID) ?? "" : "";
		const token = plaintext || formerSecret;
		if (token.length === 0) {
			delete settings.token;
			return;
		}

		try {
			// Reuse a secret already holding this token, or take a name nothing else has.
			let id = settings.tokenSecret && !formerSecret ? settings.tokenSecret : TOKEN_SECRET_ID;
			for (let n = 2; storage.getSecret(id) !== null && storage.getSecret(id) !== token; n++) {
				id = `${TOKEN_SECRET_ID}-${n}`;
			}

			storage.setSecret(id, token);
			if (storage.getSecret(id) !== token) return;

			settings.tokenSecret = id;
			delete settings.token;
			await this.saveSettings();
		} catch {
			return;
		}

		// Moving from the former secret name is housekeeping; only a token leaving
		// plain text is worth telling anyone about.
		if (!plaintext) return;
		new Notice(
			"Static Site Publisher moved your access token out of data.json into Obsidian's secret storage. Secrets are kept per device: on any other device you publish from, set the token once in the plugin settings.",
			15000
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private activeMarkdownFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file ?? null;
	}

	/** Reads the note, works out the changes, and opens the review window. */
	private async startPublish(file: TFile) {
		try {
			this.client.assertConfigured();
		} catch (error) {
			new Notice((error as Error).message, 8000);
			return;
		}

		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch (error) {
			new Notice(`Could not read ${file.path}: ${(error as Error).message}`, 8000);
			return;
		}

		const note = parseNote(content);
		const expand = (template: string) => expandPlaceholders(template, { title: file.basename });
		const { properties, removed } = resolveProperties(note.frontmatter, this.settings, expand);

		// Embeds are collected from the body that will actually be published, so
		// images sitting below the break, or inside a comment, are never uploaded.
		const breakResult = applyBreak(note.body, this.settings);
		const body = this.settings.stripComments ? stripComments(breakResult.body) : breakResult.body;
		const attachments = this.collectAttachments(file, body);

		// One lookup per path, shared by both windows, so stepping back and forth
		// and retyping a name does not re-query GitHub for a path already seen.
		const lookups = new Map<string, Promise<RemoteFile | null>>();
		const lookup = (path: string): Promise<RemoteFile | null> => {
			const cached = lookups.get(path);
			if (cached) return cached;

			const pending = this.client.getFile(path);
			// The windows report the failure; nothing is unhandled if it rejects.
			pending.catch(() => undefined);
			lookups.set(path, pending);
			return pending;
		};
		const forget = (path: string): void => {
			lookups.delete(path);
		};

		const context: ReviewContext = {
			sourcePath: file.path,
			fileName: this.defaultFileName(file, expand),
			fileNameRemembered: file.path in this.settings.publishedFileNames,
			repoLabel: `${this.settings.owner}/${this.settings.repo}`,
			branch: this.settings.branch,
			resolvePath: (fileName) => buildTargetPath(file.path, fileName, this.settings),
			attachmentPath: (attachmentName) => this.attachmentPath(file.path, context.fileName, attachmentName),
			lookup,
			forget,
			properties,
			removed,
			attachments,
			attachmentUrlPrefix: this.settings.attachmentUrlPrefix,
			breakResult,
			body,
			noteLinks: this.settings.noteLinkStyle === "text" ? findNoteLinks(body) : [],
			frontmatterError: note.frontmatterError,
			index: buildVaultIndex(this.app),
		};

		this.openReview(file, context);
	}

	/** Finds the note's embeds and pairs each with the vault file it points at. */
	private collectAttachments(source: TFile, body: string): Attachment[] {
		if (!this.settings.uploadAttachments) return [];

		const compression = imageCompression(this.settings);
		const taken = new Set<string>();
		// The same image embedded twice is one upload under one name.
		const nameOf = new Map<string, string>();

		return findEmbeds(body).map((embed) => {
			// Resolved the way Obsidian resolves the link itself, so shortest-path
			// names and full vault paths both land on the right file.
			const target = this.app.metadataCache.getFirstLinkpathDest(embed.linkpath, source.path);

			// Whether the image is compressed is settled here, from its size, since
			// converting it changes the extension of the name it is uploaded under.
			const compressTo = target ? compressionTarget(target.name, target.stat.size, compression, canEncode) : null;
			const uploadName = target ? withImageExtension(target.name, compressTo) : "";

			let fileName = "";
			if (target) {
				const known = nameOf.get(target.path);
				if (known !== undefined) {
					fileName = known;
				} else {
					fileName = sanitiseAttachmentName(uploadName);
					// Two different images can sanitise to the same name; keep them apart.
					if (taken.has(fileName)) {
						const at = fileName.lastIndexOf(".");
						const stem = at === -1 ? fileName : fileName.slice(0, at);
						const extension = at === -1 ? "" : fileName.slice(at);
						let suffix = 2;
						while (taken.has(`${stem}-${suffix}${extension}`)) suffix++;
						fileName = `${stem}-${suffix}${extension}`;
					}
					taken.add(fileName);
					nameOf.set(target.path, fileName);
				}
			}

			return {
				embed,
				file: target,
				fileName,
				alt: embed.alt,
				size: target?.stat.size ?? 0,
				missing: target === null,
				uploadName,
				compressTo,
			};
		});
	}

	/**
	 * Works out what each attachment needs before anything is shown: its path in
	 * the repository, its bytes, and whether it is new, changed, or already there
	 * unchanged — so the preview can say exactly what will be committed, and an
	 * unchanged post with unchanged images is recognised as nothing to publish.
	 */
	private async planUploads(context: ReviewContext): Promise<PlannedUpload[]> {
		// One upload per repository path: an image embedded more than once is sent once.
		const unique = new Map<string, Attachment>();
		for (const attachment of context.attachments) {
			if (attachment.file === null || attachment.fileName.length === 0) continue;
			const path = joinPath(this.settings.attachmentFolder, context.attachmentPath(attachment.fileName));
			if (!unique.has(path)) unique.set(path, attachment);
		}

		// What is already there is read one folder at a time — with images grouped
		// by post, one call for the whole publish — rather than downloading each
		// image just to learn its SHA.
		const listings = new Map<string, FolderListing>();
		const remoteSha = async (path: string): Promise<string | null> => {
			const at = path.lastIndexOf("/");
			const folder = at === -1 ? "" : path.slice(0, at);
			const name = path.slice(at + 1);

			let listing = listings.get(folder);
			if (!listing) {
				listing = await this.client.listFiles(folder);
				listings.set(folder, listing);
			}

			const sha = listing.shas.get(name);
			if (sha !== undefined) return sha;
			// Too big a folder to list in full: absent from the list is not proof of absence.
			return listing.complete ? null : (await this.client.getFile(path))?.sha ?? null;
		};

		const plan: PlannedUpload[] = [];
		for (const [path, attachment] of unique) {
			const original = await this.app.vault.readBinary(attachment.file as TFile);
			const bytes = await this.compressed(attachment, original);
			const existing = await remoteSha(path);
			// Without a local hash there is no telling, so it is sent as changed.
			const local = await gitBlobSha(bytes);

			plan.push({
				path,
				fileName: attachment.fileName,
				bytes,
				originalSize: original.byteLength,
				remoteSha: existing,
				status: existing === null ? "new" : existing === local ? "unchanged" : "changed",
			});
		}
		return plan;
	}

	/**
	 * The bytes an image is uploaded as: shrunk when it is over the size limit.
	 * Kept in its own format, a re-encoding that comes out no smaller, or that
	 * fails, is dropped for the original. Converted, the new name's extension
	 * promises the new format, so a failure stops the publish instead.
	 */
	private async compressed(attachment: Attachment, original: ArrayBuffer): Promise<ArrayBuffer> {
		const file = attachment.file as TFile;
		const inputType = imageMimeType(file.name);
		if (attachment.compressTo === null || inputType === null) return original;

		const converting = attachment.compressTo !== inputType;
		try {
			const bytes = await compressImage(original, inputType, attachment.compressTo, imageCompression(this.settings));
			return converting || bytes.byteLength < original.byteLength ? bytes : original;
		} catch (error) {
			if (converting) throw new Error(`Could not compress ${file.path}: ${(error as Error).message}`);
			return original;
		}
	}

	private openReview(file: TFile, context: ReviewContext) {
		// The modal edits context.properties in place, so stepping back from the
		// preview reopens the review window with the user's edits still there.
		new ReviewModal(this.app, context, () => {
			void this.openPreview(file, context);
		}).open();
	}

	/**
	 * The body as published: embeds rewritten to point at their uploaded copies,
	 * then links to other notes and highlights converted for the site.
	 */
	private publishedBody(context: ReviewContext): string {
		const replacements = context.attachments
			.filter((attachment) => !attachment.missing && attachment.fileName.length > 0)
			.map((attachment) => ({
				index: attachment.embed.index,
				length: attachment.embed.length,
				text: renderEmbed(
					attachment.alt,
					attachmentUrl(this.settings.attachmentUrlPrefix, context.attachmentPath(attachment.fileName)),
					attachment.embed.width,
					this.settings.imageSizeStyle
				),
			}));

		let body = rewriteBody(context.body, replacements);
		if (this.settings.noteLinkStyle === "text") body = noteLinksToText(body);
		return convertHighlights(body, this.settings.highlightStyle);
	}

	private async openPreview(file: TFile, context: ReviewContext) {
		// The break is already applied to the body the embeds were found in.
		const output = buildOutput(this.publishedBody(context), context.properties);
		const targetPath = context.resolvePath(context.fileName);

		let remote: RemoteFile | null = null;
		let remoteError: string | null = null;
		try {
			remote = await context.lookup(targetPath);
		} catch (error) {
			remoteError = (error as Error).message;
		}

		let uploads: PlannedUpload[] | null = null;
		let uploadsError: string | null = null;
		try {
			uploads = await this.planUploads(context);
		} catch (error) {
			uploadsError = (error as Error).message;
		}

		const postUnchanged = remote !== null && !remote.tooLarge && remote.content === output;

		new PreviewModal(this.app, {
			targetPath,
			repoLabel: context.repoLabel,
			branch: this.settings.branch,
			output,
			remote,
			remoteError,
			postUnchanged,
			uploads,
			uploadsError,
			onBack: () => this.openReview(file, context),
			// The SHA the diff was built against, so a file that moved on underneath
			// us is rejected rather than clobbered. Undefined means "look it up".
			onPublish: () =>
				this.commit(file, targetPath, output, context, {
					expectedSha: remoteError ? undefined : remote?.sha ?? null,
					postUnchanged,
					uploads,
				}),
		}).open();
	}

	/**
	 * Commits the post and its new or changed attachments as one commit, so a post
	 * never lands referring to an image that failed to upload, and a failure
	 * leaves the repository exactly as it was.
	 */
	private async commit(
		file: TFile,
		targetPath: string,
		output: string,
		context: ReviewContext,
		options: { expectedSha?: string | null; postUnchanged: boolean; uploads: PlannedUpload[] | null }
	) {
		try {
			// The preview could not check the attachments: check them now, and stop if it still fails.
			const plan = options.uploads ?? (await this.planUploads(context));
			const attachments = plan.filter((upload) => upload.status !== "unchanged");

			const files: CommitFile[] = attachments.map((upload) => ({
				path: upload.path,
				content: upload.bytes,
				expectedSha: upload.remoteSha,
			}));
			if (!options.postUnchanged) {
				files.unshift({ path: targetPath, content: output, expectedSha: options.expectedSha });
			}

			if (files.length === 0) {
				new Notice(`Nothing to publish: ${targetPath} and its attachments are already up to date.`, 6000);
				await this.rememberFileName(file, context.fileName).catch(() => undefined);
				return;
			}

			const message = this.commitMessage(file, targetPath, {
				post: options.postUnchanged ? null : options.expectedSha === null ? "new" : "changed",
				attachments,
			});
			const progress = files.length > 1 ? (step: string) => new Notice(step, 3000) : undefined;
			const result = await this.client.commitFiles(files, message, progress);

			const count = attachments.length;
			const withAttachments = count > 0 ? ` with ${count} attachment${count === 1 ? "" : "s"}` : "";
			const summary = options.postUnchanged
				? `Uploaded ${count} attachment${count === 1 ? "" : "s"}. ${targetPath} was already up to date, so it was left as is.`
				: `${result.created.has(targetPath) ? "Created" : "Updated"} ${targetPath}${withAttachments} on ${this.settings.branch}.`;
			new Notice(
				withLinks(summary, [
					{ text: "View commit", url: result.commitUrl },
					{ text: "View post", url: this.client.fileUrl(targetPath) },
				]),
				// Long enough to reach for a link; a click anywhere else dismisses it.
				15000
			);
		} catch (error) {
			// Whatever is at the path may have moved on; going Back must read it afresh
			// rather than diff and commit against the version that was just rejected.
			context.forget(targetPath);
			new Notice(`Publish failed, and nothing was committed: ${(error as Error).message}`, 10000);
			throw error;
		}

		// After the commit, and outside its error handling: failing to remember the
		// name must not be reported as a failed publish.
		await this.rememberFileName(file, context.fileName).catch(() => undefined);
	}

	/**
	 * Where an image goes, relative to the attachment folder: inside the post's own
	 * subfolder when images are grouped by post, which follows the post's filename
	 * as it currently stands in the review window.
	 */
	private attachmentPath(vaultPath: string, postFileName: string, attachmentName: string): string {
		if (!this.settings.groupAttachmentsByPost) return attachmentName;
		const folder = postAttachmentFolder(postRelativePath(vaultPath, postFileName, this.settings));
		return folder.length > 0 ? `${folder}/${attachmentName}` : attachmentName;
	}

	/**
	 * The filename a note is offered under: the one it was last published under,
	 * or else the default filename template filled in for it.
	 */
	private defaultFileName(file: TFile, expand: (template: string) => string): string {
		const remembered = this.settings.publishedFileNames[file.path];
		if (remembered) return remembered;

		const template = this.settings.fileNameTemplate.trim() || DEFAULT_SETTINGS.fileNameTemplate;
		const name = normaliseFileName(expand(template));
		return name.length > 0 ? name : defaultFileName(file.path);
	}

	private async rememberFileName(file: TFile, fileName: string): Promise<void> {
		const name = normaliseFileName(fileName);
		if (this.settings.publishedFileNames[file.path] === name) return;
		this.settings.publishedFileNames[file.path] = name;
		await this.saveSettings();
	}

	/**
	 * The template fills the summary line. When a commit carries more than the post
	 * alone, the files it touches are listed beneath, so the history says which
	 * images went up with which post.
	 */
	private commitMessage(
		file: TFile,
		targetPath: string,
		contents: { post: "new" | "changed" | null; attachments: PlannedUpload[] }
	): string {
		const template = this.settings.commitMessageTemplate.trim() || DEFAULT_SETTINGS.commitMessageTemplate;
		const summary = expandPlaceholders(template, { title: file.basename, extra: { path: targetPath } });

		if (contents.attachments.length === 0) return summary;

		const lines = [
			...(contents.post ? [`- ${targetPath} (${contents.post})`] : []),
			...contents.attachments.map((upload) => `- ${upload.path} (${upload.status})`),
		];
		return `${summary}\n\n${lines.join("\n")}`;
	}
}

/** A notice's text followed by links, each opening in the browser. */
function withLinks(text: string, links: Array<{ text: string; url: string }>): DocumentFragment {
	const fragment = createFragment();
	fragment.createDiv({ text });
	const row = fragment.createDiv({ cls: "ssp-notice-links" });
	for (const link of links) {
		row.createEl("a", { text: link.text, href: link.url });
	}
	return fragment;
}

/** The secret the access token is kept in. */
const TOKEN_SECRET_ID = "static-site-publisher-token";

/** The plugin's id, and its token's secret name, before it was renamed in 0.3.0. */
const FORMER_PLUGIN_ID = "publish-to-github";
const FORMER_TOKEN_SECRET_ID = "publish-to-github-token";

/** Joins a repository folder and a filename, tolerating stray slashes. */
function joinPath(folder: string, name: string): string {
	const base = folder.replace(/^\/+|\/+$/g, "").trim();
	const leaf = name.replace(/^\/+/, "");
	return base.length > 0 ? `${base}/${leaf}` : leaf;
}

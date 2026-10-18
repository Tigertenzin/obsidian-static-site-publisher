# Static Site Publisher

An Obsidian plugin that publishes the active note to the GitHub repository behind a static
site, rewriting its frontmatter properties and trimming private content on the way out. The note
in your vault is never modified — every change applies only to the copy that lands in the
repository.

*Formerly called Publish to GitHub. Upgrading from it? See [Upgrading from Publish to
GitHub](#upgrading-from-publish-to-github).*

## Disclosures

- **Requires a GitHub account** and a personal access token you create there, limited to the
  one repository you publish to. See [About the token](#about-the-token).
- **Network use:** the plugin talks only to GitHub's API, `https://api.github.com`, and only to
  read and write files in that repository. It sends nothing anywhere else and has no telemetry.
- **The token** is kept in Obsidian's secret storage on your device, never in your vault, and
  never appears in a note, a commit or an error message.
- **Images are converted on your device.** Resizing and compressing happen inside Obsidian;
  no image is sent anywhere but your own repository.

## Why this exists

Posts for my [Eleventy](https://www.11ty.dev/) blog get written in Obsidian anyway, so the
publishing step was the only part still done by hand: copy the note out of the vault, strip
the properties that are for me rather than for the site, add the ones Eleventy's frontmatter
expects, delete the working notes at the bottom, save it into the site repository's posts
folder, commit, push. This plugin is that whole routine behind one command.

Everything it does is shaped by that workflow:

- **Vault properties and site properties are different sets.** The vault ones — status
  markers, private links, anything used for organising notes — are stripped, and Eleventy's
  own (`layout`, `date`, `tags`, `permalink`, whatever the site's collections need) are
  written in with the values filled in at publish time.
- **A note is longer than a post.** Drafting notes, sources, and to-dos live below a
  horizontal rule and never leave the vault.
- **Images are pasted into the vault, not the site.** Obsidian writes an embed as
  `![[attachments/Pasted image 20260822005058.png|450]]`, which Eleventy cannot render and
  which points at a file the site repository has never seen. The plugin uploads the image and
  rewrites the embed to match.
- **Photos from a phone are far too big for a web page.** An iPhone photo is 3–5 MB, and
  GitHub warns about files that size. The plugin converts images to JPEG or WebP and scales
  them down before uploading, so the same photo goes up at around 150 KB.
- **The source note stays canonical.** The vault keeps the full note with its own
  properties; only the copy sent to the repository is rewritten.
- **Posts get republished.** A post is rarely right the first time, so publishing over an
  existing file shows a diff against what is currently in the repository and takes a separate
  confirmation before overwriting it.

Nothing in it is Eleventy-specific — any repository-backed site with frontmatter-driven posts
works the same way. Point the target folder at the site's posts directory (`src/posts`,
`content/blog`, or wherever the collection reads from) and the rest is settings.

## The command

`Static Site Publisher: Publish current note` (command palette) walks through:

1. **Review window** — the filename the post is published under, and the complete frontmatter
   of the published copy, laid out for editing. The settings decide what it starts as; from
   there you can change any value, rename or retype any property, drop one with its trash
   button, add a new one that lives nowhere in the settings, and restore anything the settings
   stripped. It also lists the images it will upload, where each can be converted and
   compressed with its own format and quality, and spells out what the break marker will cut.
2. **Preview window** — shows the exact markdown that will be committed, and where. `Back`
   returns to the review window with your edits intact.
3. **Overwrite confirmation** — only when a different file is already at that path. See below.

Edits in the review window apply to that one publish. Nothing there is written back to the
note or to the settings.

When the publish succeeds, the notice that says so links to the commit and to the post on
GitHub, and stays up long enough to click either.

The **filename** field starts from the *Default filename* setting — `{{slug}}.md` on a new
install, so `My Post` is offered as `my-post.md` — and is yours to change, since posts are
usually titled one way in the vault and slugged another on the site. Once a note has been
published, it is offered the filename it was last published under instead (marked *as last
published*), so republishing goes back to the same file even if the template or the date has
changed since; this follows the note if you rename or move it in the vault. It accepts a name with
or without `.md` — `.mdx` and `.markdown` are kept too, and anything else, like the `.2` in
`Release 1.2`, gets `.md` added — and a name containing slashes nests the post further inside
the target folder. The full path it resolves to is shown directly underneath.

While the review window is open, the plugin checks that path in the repository and reports
what it finds: a new file, or one that is already there and would be replaced. Editing the
filename re-checks the new path.

Each property row shows where it came from — *from note*, *from settings*, or *added here* —
along with its type. Values the inputs cannot represent (nested YAML, lists of objects) are
shown read-only as *nested value* and passed through to the published copy untouched.

## Images

Obsidian embeds a pasted image as a wikilink with an optional size —
`![[attachments/Pasted image 20260822005058.png|450]]` — which is neither markdown a static
site generator will render nor a path that exists in the site repository. With attachment
uploading on, publishing a post also:

1. finds every embed in the part of the note being published (images below the break are
   ignored, since they are not going anywhere),
2. resolves each one against the vault exactly the way Obsidian resolves the link, so both
   full vault paths and Obsidian's shortest-path names work,
3. uploads it into the repository's attachment folder under a URL-safe name, and
4. rewrites the embed to point at the uploaded copy.

**Each post gets its own image folder.** By default a post's images go into a subfolder of
the attachment folder named after the post: `My Post.md` published to `2024/` puts its
images in `posts/attachments/2024/my-post/`. Two posts that both embed a `diagram.png` can
then never overwrite each other's image. The subfolder follows the post's filename as you
edit it in the review window. Turn off *Group images by post* to put every image straight
into the attachment folder instead. A name with nothing URL-safe in it, such as one written
entirely in Japanese, becomes `post-` or `attachment-` plus a short hash of the original, so
two such names still stay apart.

The review window lists every image with its size, the filename it will be uploaded under,
and an alt text field — a wikilink embed carries no alt text, so this is the place to add it.
Both are editable, and the resulting URL is shown beneath. A name you type is cleaned the same
way the automatic ones are — `My Diagram` becomes `my-diagram.png` — keeps the extension of
the format the image is uploaded in whatever you type, and cannot include a folder. Clearing the name leaves that embed
exactly as written. Two different images cannot share a name. An image embedded more than once
is uploaded once: each embed keeps its own alt text, but they share one name, so renaming one
renames them all. An embed whose file cannot be found
in the vault is flagged and left in the note exactly as written rather than being rewritten to
a broken link.

**The post and its images are published in one commit**, so they land together or not at
all: a post never refers to an image that failed to upload, and a failed publish leaves the
repository exactly as it was. The commit message is your template, followed — when images are
included — by a list of the files it touches and whether each is new or changed. An image
already in the repository byte for byte is skipped rather than
committed again — the plugin compares the git blob hash of the file it would upload, after any
conversion, against the one
GitHub reports, reading the hashes for a whole folder in one request rather than downloading
each image. If the repository cannot be checked, nothing is published.

The check happens before the preview opens, so the preview lists every attachment as *new*,
*changed* or *unchanged, skipped*. When the post itself is identical to what is already in the
repository it is left alone — no commit, and no overwrite warning — and only new or changed
attachments are uploaded. If nothing at all would change, the preview says so and there is
nothing to press.

**Sizes.** `![[image.png|450]]` has no markdown equivalent. By default the size is kept by
publishing an `<img src="…" alt="…" width="450">` tag, which any markdown renderer passes
through; set *Image sizes* to `Drop` for plain `![alt](url)` markdown instead. Embeds with no
size are always plain markdown.

**Images are converted to a web format.** A photo straight from a phone camera can weigh several
megabytes, and a pasted screenshot is a heavy PNG. Still images (JPEG, PNG, WebP, BMP, AVIF) are
converted to JPEG by default, or WebP if you prefer, scaled down so the longest edge fits
*Maximum width or height* (2000 px), and uploaded in that form. A typical 4032 × 3024 iPhone
photo of 3–5 MB comes out at around 150 KB. The image in the vault is never changed. GIFs are
always uploaded as they are so they stay animated, and so are SVGs.

The review window lists every image with a thumbnail of the original, its dimensions and size,
and two controls of its own:

- **Format**: JPEG, WebP, or the original file, untouched. Changing it renames the upload to
  the new extension.
- **Quality**: how hard it is compressed.

Nothing is converted until you ask. Press **Convert** under an image to convert just that one,
or **Convert all images** at the foot of the window to work through them all, with a progress
bar and a button to stop. Continuing to the preview converts whatever is still waiting first,
so nothing is ever uploaded unconverted by mistake. A converted image shows a thumbnail of
exactly what will be uploaded and its size before and after; change its format or quality
afterwards and it is converted again on the spot.

Images are always converted **one at a time**, and each photo's memory is let go as soon as it
is done. A phone holds a decoded photo at around ten times its file size, and converting a
post's photos side by side is enough for iOS to close the app; one at a time, only a single
photo is ever held, however many the post has. The thumbnails before conversion come straight
from Obsidian, so opening the window reads nothing into memory either.

The settings pick what each image starts with, and conversion corrects that starting point
once it has seen the image: a picture with see-through areas switches to WebP, since JPEG would
fill them with white; one that converting would only make larger, or that this device cannot
convert at all, is kept as it is. It says so when it does. A choice you make yourself is never
overridden: if an image you set by hand cannot be converted, it says why and which image, and
the preview waits until you try again or choose Original. An image already in the chosen
format and no bigger than *Leave small images alone* (500 KB) starts out untouched, since
re-encoding it would only lose quality. The preview lists each converted image's size before
and after.

Conversion happens on the device you publish from, so an image published from two different
devices may be re-uploaded as *changed* even though the vault copy is the same. Some devices,
Safari on older iPhones among them, cannot write WebP; there it is offered greyed out, and a
WebP default falls back to JPEG.

**Video, audio and PDFs.** Markdown image syntax only shows images, so other embeds are
written in the form that works for them: video as `<video src="…" controls>` (keeping its
width under the same setting as images), audio as `<audio src="…" controls>`, and a PDF as a
plain link, `[report.pdf](…)`. The review window's alt text field becomes the player's
screen-reader label, or the PDF's link text.

**What is left alone.** Links to the web, paths already rooted at the site (`/posts/…`), and
anything inside a fenced or inline code block. Embeds of notes rather than media, like
`![[Some Note#Heading]]` or a `.base` file, are not uploaded; they are handled with the other
links to notes, under [Obsidian syntax](#obsidian-syntax).

## Obsidian syntax

Some of what Obsidian understands means nothing on a website, so the published copy converts it:

- **Links to other notes** — `[[My Other Post]]`, `[[My Other Post|this post]]`, note embeds
  like `![[Other note]]`, and markdown links to `.md` files — point at notes the site does not
  have, so they are published as plain text: the link's display text, or else the note's name.
  The review window lists every link it converts, in case one was meant to point at a page on
  your site; replace those with ordinary links in the note.
- **Comments** (`%% … %%`, inline or spanning lines) are left out. They are removed before
  images are collected, so an image inside a comment is not uploaded.
- **Highlights** (`==text==`) become `<mark>text</mark>`.

Code blocks and inline code are never touched. Each conversion can be changed or turned off
under *Obsidian syntax* in the settings.

## Suggestions

Fields that name something which already exists offer it rather than asking you to remember it.

- **Property names** — in both settings lists and in the review window — are suggested from the
  properties the vault actually uses, most widely used first. The review window leaves out
  names the note is already writing, and the removal list leaves out ones already listed.
- **Property values** are suggested from the values that property already takes across the
  vault, so a `layout` field offers the layouts that exist and a `status` field the statuses in
  use. List properties get their known values as clickable chips under the box instead, since a
  dropdown would fight with typing several values.
- **Repository folders** for the target and attachment folders are read from the branch itself.
  Focus an empty field to browse every folder in the repository; type to narrow it.

Everything stays a plain text field — a suggestion is a shortcut, never a restriction, so a
folder or property that does not exist yet can still be typed in. Matches on a prefix are
listed before matches anywhere in the name, and arrow keys plus Enter pick one.

## Republishing over an existing post

When a file already exists at the target path — the usual case for a post being revised —
the second window becomes a review of the changes rather than a plain preview:

- A **Changes** view diffs the published copy against the file currently in the repository,
  showing added and removed lines with three lines of context and collapsing long unchanged
  runs. **Full document** switches to the complete output.
- The header carries the line counts, `+N −M`.
- Publishing is relabelled **Overwrite…** and opens a third confirmation naming the file,
  the branch, and the size of the change.

Two cases short-circuit the diff. When the output is identical to what is already there, the
post is left alone: the window says so, and publishing uploads only new or changed images — or,
when there are none, there is nothing to press. And a file too large for GitHub to return inline
cannot be diffed, which the window says plainly before letting you replace it.

The commit is made against the exact version the diff was built from. If the post — or any
image being replaced — changes on GitHub between the diff and the confirmation, or someone
creates a file at a path that was free when it was checked, nothing is committed rather than
quietly overwriting the newer version. Go `Back` and continue to the preview again: the plugin
reads the file afresh, so the diff you see is against the newer version before you publish over
it. Commits that only touch other files are no obstacle: the plugin re-checks against them and
commits on top.

## Settings

### GitHub connection

| Setting | Meaning |
| --- | --- |
| Repository owner / name | The target repository. |
| Branch | Branch the commit lands on. Must already exist. |
| Personal access token | The secret, in Obsidian's secret storage, that holds a fine-grained token limited to the one repository, with **Contents: read and write**. See below. |
| Target folder | Folder inside the repository to publish into — the site's posts folder. Focus the field to browse the folders that exist on the branch. Empty means the repository root. |
| Default filename | The filename a note is first offered under, with placeholders (see below). `{{slug}}.md` on a new install; an install upgraded from an earlier version keeps `{{title}}.md`, the note's own name, so existing posts are not republished under a new name. |
| Mirror vault folder structure | Append the note's folder path inside the vault to the target folder. |
| Commit message | The commit's summary line, with placeholders, plus `{{path}}` for the post's path in the repository. |

`Test` checks that the token can reach both the repository and the branch.

**Placeholders**, in the default filename, the commit message and default property values:

| Placeholder | Becomes |
| --- | --- |
| `{{title}}`, `{{filename}}` | The note's name: `My Post` |
| `{{slug}}` | The note's name, URL-safe: `my-post` |
| `{{date}}`, `{{time}}`, `{{datetime}}` | Now: `2026-10-05`, `14:30`, `2026-10-05T14:30` |
| `{{date:FORMAT}}` | Now, in a format of your own, as `{{date:MMMM D, YYYY}}` → `October 5, 2026`. Takes [Moment.js format tokens](https://momentjs.com/docs/#/displaying/format/), the same as Obsidian's date settings. |

An unrecognised placeholder is left as written.

### How connecting to GitHub works

There is no "sign in with GitHub" step, and no account gets connected. The whole arrangement is:

1. **You create a key on GitHub** — a fine-grained personal access token. It is a long string that
   works like a password with one narrow job, and you choose exactly what it opens: one
   repository, files only.
2. **You paste it into the settings**, as a secret in Obsidian's secret storage.
3. **Obsidian keeps it on this device**, outside your vault; the plugin's settings record only
   the secret's name.
4. **Every time it publishes, the plugin shows that key to GitHub.** GitHub sees a valid key for
   that one repository and allows the write. That is the authorization, and it happens on every
   request rather than once at setup.

So GitHub never tells the plugin your password, and never tells it who you are — it does not know
your username unless you type it in. The plugin can do exactly what the key permits and nothing
else. Revoke the key on GitHub and the plugin stops working immediately; there is nothing to
disconnect.

The tradeoff of having no login handshake is that the key simply sits on your device, which is
why its scope is the thing that matters.

### About the token

Create a **fine-grained** personal access token, not a classic one. Under *Repository access*
pick **Only select repositories** and choose the site's repository alone; under *Permissions*
grant **Contents: Read and write** — GitHub adds *Metadata: Read* automatically, and nothing
else is required. That is the whole surface: a token that can read and write files in one
repository and do nothing else, to any account, ever. Set an expiry date; the plugin says
plainly when a token has expired.

A classic token with the `repo` scope also works and is the wrong choice — it grants full
control of every repository you can reach, including private ones the plugin has no business
touching.

**Where the token lives.** In Obsidian's secret storage (Obsidian 1.11.4 and later), which
belongs to the device rather than the vault. The plugin's `data.json` records only the
secret's name, so backups, file-sync services, git, and Obsidian Sync copy the name and never the
token. The flip side: on each device you publish from, set the token once in the plugin's
settings — another device's secret does not travel with the vault. Scoping the token to the one
repository and giving it an expiry is still worth doing, so a token that does escape is worth
as little as possible.

**Upgrading from an earlier version.** Earlier versions kept the token in plain text in
`data.json`. On first load, the plugin moves it into secret storage under the name
`static-site-publisher-token`, checks that it reads back, and only then removes it from
`data.json`, with a notice saying so. If the move cannot be made, the token stays where it was
and keeps working, and the move is tried again on the next load. On another device that syncs
the vault, set the token once in settings after the upgrade.

**What the plugin does with it.** The token is sent as an `Authorization` header to
`https://api.github.com`, which is a hardcoded constant — no setting can redirect it elsewhere.
It is never written into a note, a commit, or the published output, never logged, and stripped
out of any error message before that message is shown. The plugin makes no other network
requests of any kind.

### Properties to add

Each row is `name · type · default value · keep existing value`.

- **type** is one of text, number, checkbox, date, date & time, or list, and decides which input
  the review window shows.
- **default value** prefills that input, and can use placeholders — `{{date}}` for a date
  property, say, or `{{slug}}` for a slug.
- **keep existing value** on: when the note already carries the property, its own value is used
  instead of the default. Off: the default always wins, which is how you overwrite a property.

These are defaults for the review window, not fixed rules — every one of them can be changed
or overridden there before publishing. Leaving a value empty in the review window omits that
property from the published copy.

A key listed in both *properties to add* and *properties to remove* is added: the add list
states a value, so it is treated as the more specific instruction.

### Properties to remove

One row per property. Any of these present in the note are stripped from the published copy,
and listed under *Removed by settings* in the review window with a button to restore one for
that publish. The name field suggests properties the vault actually uses, leaving out the ones
already on the list.

### Content break

With the break enabled, everything from the first line matching the break marker onwards is left
out. The default marker is `---`, a horizontal rule, so a note can carry private working notes
below the rule and publish only what sits above it. The marker is matched against a whole line,
ignoring surrounding whitespace, and is only searched in the body — the frontmatter delimiters
are never mistaken for it.

Two kinds of matching line are not breaks. A marker inside a fenced code block is just code.
And a `---` (or `===`) directly under a line of text is how markdown underlines a heading, so
it is not a rule at all: write a blank line above a `---` you mean as the break. When a marker
is passed over as a heading underline, the review window says so.

**A horizontal rule is also an ordinary way to separate sections**, and the break takes the
*first* one it finds. A note that uses `---` between sections will be cut at the first of them.
So the review window always reports which line the marker was found on, how many lines are
about to be dropped, and offers the dropped content for inspection; when the cut would remove
more than half the note, it says so as a warning rather than a note. If your notes use `---`
freely, set the marker to something that cannot collide — `%%publish-break%%` uses Obsidian's
comment syntax and stays invisible in reading view.

### Obsidian syntax

| Setting | Meaning |
| --- | --- |
| Links to other notes | Publish them as plain text (default), or leave them as written for sites that understand wikilinks. |
| Remove comments | Leave `%%comments%%` out of the published copy. On by default. |
| Highlights | Publish `==text==` as a `<mark>` tag (default), as plain text, or as written. |

### Attachments

| Setting | Meaning |
| --- | --- |
| Upload embedded images | Whether to handle embeds at all. Off leaves every embed untouched. |
| Attachment folder | Folder inside the repository that images are committed to. Browses existing folders the same way. |
| Group images by post | Put each post's images in their own subfolder, named after the post. On by default; off puts every image straight into the attachment folder. |
| Attachment URL prefix | What the rewritten embeds point at — usually the attachment folder with a leading slash, since the site serves it from the root. |
| Image sizes | Keep an Obsidian size as an `<img width>` tag, or drop it for plain markdown. |
| Convert images | Convert still images to JPEG or WebP, scaled down and compressed, before uploading. On by default. Each image can still be changed in the review window. |
| Image format | What images are converted to: JPEG (the default, works everywhere) or WebP (smaller, keeps transparency). |
| Image quality | The quality images start with in the review window, 10–100. Defaults to 80. |
| Maximum width or height (px) | The longest edge a converted image is scaled down to. 0 keeps its full size. Defaults to 2000. |
| Leave small images alone (KB) | An image already in the chosen format and no bigger than this starts out untouched. Defaults to 500. |

## Building

```bash
npm install
npm run build   # type-check, then bundle to main.js
npm run dev     # rebuild on change
npm test        # run the unit tests
```

The tests in `test/` cover the plugin's own logic — frontmatter and break parsing, attachment
naming and rendering, syntax conversion, placeholders, the diff, the single-commit publish
against an in-memory fake of GitHub's API, and image conversion's choices and its
one-at-a-time queue. The conversion itself draws on a canvas, which exists only in a browser,
so it is checked by hand. Obsidian's API exists only inside the app, so
`test/obsidian.ts` stands in for the few parts of it those modules use. CI runs the type check,
the tests and the build on every push and pull request, and a release is not published unless
all three pass.

## Installing into a vault

Requires Obsidian 1.11.4 or later, for its secret storage.

Through [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `Tigertenzin/obsidian-static-site-publisher`
as a beta plugin and it installs the latest release and keeps it updated.

By hand, take `main.js`, `manifest.json` and `styles.css` from a release into
`<vault>/.obsidian/plugins/static-site-publisher/`, then enable the plugin in
*Settings → Community plugins*. During development, symlinking the repository into that path and
running `npm run dev` is quicker — note that `main.js` is a build artifact and is not committed,
so the repository alone is not installable.

### Upgrading from Publish to GitHub

Until 0.3.0 this plugin was called Publish to GitHub, with the ID `publish-to-github`. The new
ID makes it a separate plugin as far as Obsidian is concerned, so it installs alongside the
old one rather than replacing it:

1. Install Static Site Publisher and enable it. On its first load it imports everything from
   Publish to GitHub — the connection, property lists, break and attachment settings, and the
   filenames your notes were last published under — and copies your access token to its own
   secret, `static-site-publisher-token`. A notice confirms the import.
2. Uninstall Publish to GitHub.
3. Re-assign any hotkey you had for publishing; hotkeys belong to a plugin's ID, so the old one
   does not carry over.

The old secret, `publish-to-github-token`, is left in Obsidian's secret storage in case you need
the old plugin again. Once you no longer do, remove it there.

## Releasing

```bash
npm version patch      # or minor / major
git push --follow-tags
```

`npm version` writes the new version into `package.json`, `manifest.json` and `versions.json`
together and tags the commit. Pushing the tag runs `.github/workflows/release.yml`, which builds
the plugin and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`
attached — the three files BRAT and Obsidian download. The release's notes come from
`release-notes/<version>.md` when that file exists, so write it before tagging; without one,
GitHub's generated list of changes is used.

Tags carry no `v` prefix, because Obsidian compares the tag against `manifest.json` exactly;
`.npmrc` sets that, and the workflow refuses to release a tag that does not match rather than
publishing something BRAT will silently decline to install.

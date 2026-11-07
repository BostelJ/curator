# Curator

<img src="brand/app-icon.svg" width="96" align="right" alt="">

**The taste layer between every visual pass.** When an AI agent makes something visual for you, like concept art, a blockout or a 3D model, Curator puts it on your screen as a photo card while you keep working. You answer in seconds, the agent keeps refining, and everything you Keep hangs in a gallery that teaches agents your taste.

Curator is a small Mac menu bar app plus a [Claude Code](https://claude.com/claude-code) connection. Everything stays on your Mac.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/BostelJ/curator/main/scripts/install.sh | bash
```

This installs the latest release to `/Applications`, connects it to Claude Code (an MCP server named `curator` plus its skill), and starts it. Run the same command to update. Then restart any open Claude Code sessions.

Needs macOS 13 or newer, and Claude Code for agents to use it.

<details>
<summary>Installing by hand from the Releases page</summary>

1. Download `Curator-vX.Y.Z.zip` from [Releases](https://github.com/BostelJ/curator/releases), unzip it, and move `Curator.app` to `/Applications`.
2. Curator isn't notarized by Apple yet, so the first time macOS will refuse to open it. Go to **System Settings → Privacy & Security** and click **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/Curator.app`).
3. Connect it to Claude Code:
   ```sh
   claude mcp add --scope user curator -- /Applications/Curator.app/Contents/MacOS/Curator mcp
   mkdir -p ~/.claude/skills/curator && cp /Applications/Curator.app/Contents/Resources/skill/SKILL.md ~/.claude/skills/curator/
   ```
</details>

## How it works

Ask Claude Code for anything visual, and it uses Curator on its own. You can also just say "use Curator".

1. **Quick pick.** Concepts arrive at the top of your screen as a head-to-head tournament: two prints at a time, winners advance to a final. ← → to move, Return to choose, or click. Each decision tosses the pair off your desk like paper, and the next pair is dealt in. The agent gets the winner, the runner-up and every match. Press N to write a note instead: **Send note** ends the pick right there and the note is the answer (combine these, none of them, draw more), with a slip that says it was sent. **Note + keep picking** holds the note and sends it with your winner. Video clips work too: the two in a match play in sync, with one bar to pause, scrub, step a frame or slow down, so animations compare beat for beat.
2. **Refine.** Real passes ("here's your modeled house, any changes?") stack in the bottom-right corner. **Keep** it, or type a note that goes to the agent word for word. Click a card to enlarge it; 3D models can be turned and zoomed, and clips can be scrubbed. The pencil lets you draw on it in red marker, so your note can point at exactly what you mean (on a clip, it freezes the frame you're on and tells the agent the moment).
3. **Art gallery** (⌃⌥G). Each project's taste, as a manifesto: the taste rules you've accepted are the headline, and every kept asset is a print you can open to see the passes and notes behind it. Agents read it before their next pass. It shows current taste only: newer Keeps replace older ones, and prints that no longer fit move to a Retired shelf you can restore from.

Agents can also propose taste rules when they spot a pattern in your answers. Only the ones you accept count.

## Keys

Curator only takes a key while it needs it, because a held key is taken from the app in front of you.

| When | Keys |
|---|---|
| A quick pick is showing | ← → choose · F full screen · Esc look later · ⌃⌥N note · ⌃⌥⌫ delete |
| Once you've started on it | Return commit · N note · ⌫ delete · ⌃⌥Z undo |
| A refine card is waiting | ⌃⌥K Keep · ⌃⌥N note · ⌃⌥⌫ delete · ⌃⌥F full screen (enlarged: N, ⌫, Esc, F) |
| Full screen | Everything above with plain keys · ← → between a card's images · F or Esc back |
| A pick has tucked away | ⌃⌥P bring it back · ⌃⌥F bring it back full screen |
| Always | ⌃⌥G art gallery |

A pick left alone for 45 seconds tucks into a small tab and lets go of the keys. While you type a note, Curator holds nothing but ⌃⌥G. **Pause Cards** is in the menu bar menu.

## Privacy

Curator runs entirely on your Mac. Cards and kept work live in `~/Library/Application Support/Curator`, and the app only listens on `127.0.0.1`, behind a random token. Nothing is uploaded anywhere.

## Uninstall

```sh
osascript -e 'quit app "Curator"'; rm -rf /Applications/Curator.app ~/.claude/skills/curator
claude mcp remove --scope user curator
# and, to delete your boards too:
rm -rf ~/Library/Application\ Support/Curator
```

## Building from source

Needs only the Xcode command line tools.

```sh
scripts/build.sh --install                             # builds and replaces /Applications/Curator.app
swift scripts/make-icon.swift Resources/Curator.icns   # only when the icon changes
```

To release, push a tag like `v0.2.0`. GitHub Actions builds it for Apple Silicon and Intel and publishes the release (`.github/workflows/release.yml`).

One binary does both jobs: with no arguments it's the menu bar app, and `Curator mcp` is the stdio bridge Claude Code talks to.

- `Sources/Curator`: the AppKit shell. Non-activating panels, Carbon hot keys, a loopback HTTP server, and the store.
- `Resources/web`: everything you see, as HTML, CSS and JS in web views. `photo.css` is the look.
- `skill/curator/SKILL.md`: how agents should use Curator. It ships inside the app.
- `brand/`: the logo masters as SVG.

### Testing without touching the screen

`CURATOR_HOME=<dir> CURATOR_QUIET=1 CURATOR_DEBUG=1 dist/Curator.app/Contents/MacOS/Curator` runs a copy with separate data. Its panels are invisible, it takes no clicks, keys or typing, and `POST /api/debug` can press keys, run script in a page, and snapshot panels. Quit any installed copy first: only one can run at a time.

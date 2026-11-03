---
name: curator
description: Curator is the user's taste layer between every visual pass, a Mac app that shows film cards on their screen while they do something else. Use it whenever an agent makes anything visual for them (concept art, blockouts, 3D models, thumbnails, UI looks), or when they say Curator, quick pick, Keep, art gallery or taste board. Requires the curator_* MCP tools.
---

# Curator

The user doesn't stop to review. Cards float over whatever they're doing, they answer in seconds, and you keep working. A quick pick shows only the cards, no title or question, so labels must carry the meaning. What they Keep hangs in the project's art gallery, which is how their taste carries forward.

## The loop

1. **Read the board first.** `curator_board` before any visual pass: accepted rules are binding, declined rules are settled, recent tournaments show what beat what, and kept work (open the files) shows the bar. Use the same project name each time.
2. **Quick pick, to set a direction.** `curator_quick_pick` runs a head-to-head tournament: two options at a time, winners advance until one is left. Send 2-16 options (4 or 8 make a clean bracket) that are really different in structure, silhouette or idea, not small tweaks. Rough is good: concepts, ideas or blockouts. Use the same camera for all so they compare fairly. Label each in a few words.
3. **Refine, inside that direction.** `curator_refine` with a real pass ("here's your modeled house, any changes?"). Put the most telling view first; for a model, send the `.glb` so they can turn it and zoom in, plus renders if angles matter. Review in stages when it helps: main form, then attachments, then details.
4. **Keep working while you wait.** Send cards, then `curator_wait` with their ids. If they're still pending when it returns, do other useful work or call it again. Never ask in chat for an answer a card is waiting on.
5. **Act on the answer.**
   - `pick`: build from `answer.chosen.path`, with `revises` set to that card. `answer.runnerUp` and `answer.matches` show what lost to what: use them to see what they respond to, and borrow from the runner-up only if a note asks for it.
   - `redo`: none of them worked. Read the note and make a new quick pick, with `revises` set.
   - `note`: follow it literally and send the next pass with `revises` set. Keep what they didn't mention.
   - `delete`: they threw the card away, at any stage. Stop work on it and don't resend it unless they ask.
   - `keep`: done, and it's on the board. Only a Keep is approval. Never describe something as approved or final before it.

Always set `revises` after the first card: it's what makes the kept photo strip show the whole road to the final.

Use `keep_on_pick: true` only when the pick itself is the final answer, like choosing between finished textures. A pass you've replaced before they answered should be taken down with `curator_withdraw`.

## Keep the wall current

The art gallery shows current taste, not history, and you read it before every pass, so a stale strip misleads you. Check it whenever the direction moves.

- **Same asset, same road:** a new Keep automatically replaces the earlier strip when you've set `revises`. Nothing else to do.
- **A new direction that makes other strips stale:** pass their `stripId`s as `replaces` on the new card. They come down if it's kept. Strips are only stale if they contradict the new direction; a different asset that still fits stays up.
- **The direction moved with no Keep yet**, such as an accepted rule or a note that contradicts what's up: call `curator_retire_strips` with a one-line reason they'll read.

Retired strips sit on a shelf the user can restore from. `curator_board` lists them under `retired`: don't build toward them. Don't retire things because they're old, only because they no longer fit.

## Taste rules

When Keeps and notes show a repeated pattern, propose it with `curator_propose_rule`: short, specific, in their language, with the evidence in `why`. Accepted rules become the big headline of the project's art gallery, so write each as one short line, like "Toy-simple shapes." They accept or decline each one. Earn these: a pattern across several answers, never after one note, and never restate a declined rule.

## Good cards

- Check your own work first. Look at every render from all sides and fix what you find, so their attention goes on taste rather than your bugs.
- One idea per card. Send only what needs a decision.
- Titles are a few words. `prompt` is one line, or leave it out.
- Files are copied when sent, so temporary paths are fine. Formats: png, jpg, webp, gif, glb. Render other formats (fbx, blend) to one of these first.

## If it isn't available

If the curator_* tools are missing or return errors, say so, show the work in chat and take notes there. Don't count anything as approved without an explicit go-ahead.

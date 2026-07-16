# 🦫🪓 DAM IT!

A cute, saucy, one-thumb beaver arcade game set in the Alberta foothills.

Chomp the aspen, dodge the branch / owl / bear on your side, and **don't stop** — a
draining timer keeps you moving. Bank the wood you cut between runs to raise the
**dam**, upgrade the **lodge**, and grow your **colony** of kits before winter.
Max it out and move downstream to a bigger, richer **valley**. Repeat forever.

## Play

- **Tap** the left/right half of the screen — or press **← / →** — to chomp that side.
- Avoid chopping the side with a hazard on it (branch, great horned owl, or clinging bear).
- Keep the timer bar from running dry.
- Between runs, spend wood in **The Valley** hub, then hit **PLAY** again.

Plays great on a phone (portrait, one thumb) or desktop.

## Run it locally

No build, no dependencies — just open the file:

```
open index.html      # macOS
start index.html     # Windows
```

## How it's built

Plain **vanilla JavaScript + HTML5 Canvas**, with a tiny **WebAudio** synth for
sound. Everything — art, animation, audio — is generated procedurally in code, so
there are **no external assets** and nothing to download. Progress is saved in the
browser via `localStorage`.

| File | What it is |
| --- | --- |
| `index.html` | Canvas + UI buttons |
| `game.js` | The whole game (loop, arcade, hub, art, audio) |
| `styles.css` | Page layout |

## License

MIT — see `LICENSE`.

# Blockwright

Design Minecraft builds away from your PC and export them as Litematica
schematics. Runs entirely on your device — no server, no account, no signal.

## Putting it on GitHub Pages (about 5 minutes)

1. Go to github.com and make a new repository. Call it `blockwright`.
   Set it to **Public** (Pages needs that on a free account).
2. On the repo page click **Add file → Upload files**, then drag in
   *everything from this folder* — keep the `js/` and `vendor/` folders intact.
   Commit.
3. Go to **Settings → Pages**. Under *Build and deployment*, set
   **Source: Deploy from a branch**, **Branch: main**, folder **/ (root)**. Save.
4. Wait a minute, then open `https://<your-username>.github.io/blockwright/`.

## Installing it on the iPad

Open that link in Safari, tap the **Share** button, then **Add to Home Screen**.
It gets an icon and opens fullscreen like an app. After the first visit it works
with no signal at all — on a plane, in the car, anywhere.

## Using it

- **Blocks tab** — search 638 blocks or filter by category. Tap one to select it.
- **PLACE** puts the selected block on the face you tap. Tap a block you placed
  to stack on top of it.
- **BREAK** removes a block. **PICK** is an eyedropper.
- **FILL** — tap two opposite corners, then use *Fill it*, *Walls only* or
  *Clear it* in the Build tab.
- **HEIGHT slider** on the right hides everything above or below, so you can see
  and work inside a build.
- **Build tab** also has: swap one block for another everywhere, a materials
  shopping list, a reference image to trace over, and a Build Board summary.
- **Export** makes a `.litematic`. Put it in `.minecraft/schematics` and
  Litematica will show you where every block goes.

Builds save themselves to the device as you work. The Projects tab lists them.

## Updating it later

Replace the changed files in the repo, and bump `CACHE` in `sw.js`
(`blockwright-v1` → `blockwright-v2`). That tells installed copies to refresh.

## What is where

| File | What it does |
|---|---|
| `index.html` | the whole interface |
| `js/app.js` | scene, picking, tools, panels |
| `js/worker.js` | holds the blocks, meshes them, applies edits |
| `js/litematic.js` | reads and writes `.litematic` (gzip + NBT) |
| `js/blocks.js` | the block palette |
| `js/projects.js` | saving builds on the device |
| `sw.js` | the offline cache |
| `vendor/three.min.js` | the 3D library, kept local so it works offline |

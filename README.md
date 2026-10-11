# Tapehead

A multitrack audio studio that runs in the browser or as a desktop app. Bring in WAV files, cut and arrange them, make beats, add effects, mix, master and export.

- **Use it in the browser:** https://senura-d.github.io/Tapehead/
- **Desktop app (Windows, macOS, Linux):** download from the repository's Actions tab → latest "Build desktop apps" run → Artifacts

It is plain HTML and JavaScript on the Web Audio API. There is no build step for the app itself.

## What it does

**Arrange and edit**
- Multitrack playlist: move, trim, split, duplicate, reverse, normalize, fade and crossfade clips
- Change a clip's length without changing its pitch, or its pitch without changing its length
- Tempo detection on import and one-click "fit to project tempo"
- Markers on the ruler, loop region, snap to grid, undo / redo
- Draw volume and pan automation on a track, or a gain curve inside a single clip
- Record from a microphone onto a track

**Make beats**
- Step sequencer with per-step velocity and rolls, swing, and up to 64 steps
- Piano roll on every channel for melodies and basslines
- Patterns sit on the playlist as live clips that follow later edits (or bounce them to audio)
- Built-in drum kit, plus save and load your own kits

**Mix**
- Per-track and master effect chains: EQ (with a spectrum display you can drag), filter, compressor, brick-wall limiter, reverb, delay, distortion, chorus, phaser, flanger, tremolo, bitcrusher, tape saturation, pitch shifter, stereo widener, noise gate, de-esser, sidechain ducking
- Buses and sends for shared effects and group faders
- Effect chain presets
- Auto mix & master: measures every track, then sets levels, panning, EQ, compression and master loudness — optionally matched to a reference song

**Save and export**
- Projects save automatically
- `.tapehead` project files hold a project and all of its audio in one file, for backup or moving between computers
- Export WAV (16 / 24-bit or 32-bit float), MP3, or stems (one WAV per track in a ZIP)

Press `?` in the app for the keyboard shortcuts.

## Your projects and updates

Projects are stored on your computer by the app (in the browser's storage, or the desktop app's data folder), not in the app's own files. Installing a newer version of the desktop app over an older one, or reloading the web version after an update, keeps them. Older projects are upgraded in place when opened; nothing is removed.

Storage is separate per place you run it: the desktop app, the hosted web version and a local copy each keep their own project list. To move a project between them, or to keep a safe copy, use **menu → Save project file** and **Import project** on the Projects screen.

## Run from source

Web version — serve the folder with any static file server and open it:

```bash
python -m http.server 5173
```

Desktop version:

```bash
npm install
npm start
```

Build installers for the current platform with `npm run dist` (output in `dist/`). Pushing a tag such as `v1.1.0` builds all three platforms on GitHub Actions.

## Credits

- Inspired by [AudioMass](https://github.com/pkalogiros/AudioMass) by Pantelis Kalogiros.
- MP3 encoding uses [lamejs](https://github.com/zhuker/lamejs) (LGPL-3.0), included unmodified in `js/vendor/`.

## License

MIT — see [LICENSE](LICENSE). The bundled lamejs library keeps its own LGPL-3.0 license.

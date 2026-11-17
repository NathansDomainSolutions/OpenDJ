# OscarDJ (beta)

A two- or four-deck DJ app for your own music and web tracks, with yt-dlp built in.

> **This is a development build with the license gate removed.** Downloads are not license-checked, and tracks
> record whatever license yt-dlp reports (or none, shown as UNCHECKED). It uses its own data folder
> (`%APPDATA%\OscarDJ`; a library already in the pre-rename `%APPDATA%\Commons DJ NoGate` folder keeps being
> used), so it doesn't touch the main app's library. The removed features and their
> known problems are written up in `docs/license-gate-features/`, to be put back one at a time.
>
> The search is also a **plain YouTube search** here (no Creative Commons filter, up to 50 results in YouTube's
> order), with a details strip showing exactly what was searched and an **Expand** button for more room. The
> search problems are written up in `docs/search-issues/`.

## What's new in 0.4.0-beta

### A new look: Frutiger Aero

- **Glass, gloss and blue sky.** The whole app is redrawn in the Frutiger Aero / Y2K style: sky-and-grass wallpapers with bubbles and a lens flare, translucent glass panels, glossy gel buttons, chrome faders and knob caps, LED meters, and a round glass Play button in each deck's colour. Everything that shows the music (the waveforms, time and BPM, the overview, the video) sits on dark glass screens, so it reads the same in every theme.
- **Five themes** (⚙ Settings → Theme): **Aero** (blue sky, the new default), **Meadow** (grass under a clear sky), **Aurora** (night glass under northern lights, the dark one), **Chrome** (Y2K silver with candy colours) and **Cherry Pop** (glossy cherry red). They replace Midnight, Aloe, Mist and Cherry; a saved Aloe or Mist choice carries over to Meadow or Chrome. The cherries stay.
- **A Frutiger-style typeface**, Istok Web (SIL Open Font License), is the new default font; Arial and the others are still in Settings → Font.
- **New app icon** to match (`scripts/make-icon.cjs` draws it).
- Keyboard shortcuts now show in the buttons' tooltips, and **B** expands the library.
- The look lives in `src/renderer/aero.css`; `styles.css` keeps the layout. `test/theme-shots.cjs` saves a screenshot of every theme to `out/shots/` without opening a window.

### Sync that syncs, and a smoother app

- **Sync rewritten from the ground up** (`sync.js`). Pressing Sync now does one thing: it puts this deck's beats on the other deck's beats, at once, and holds them there. It no longer swaps a track's BPM for another "reading" behind your back. That was the bug where the two tempo displays agreed but the music didn't: a 130 BPM track could quietly become 97.5, and its beats then ran 4-against-3 with the other deck.
- **Tracks whose tempo wanders stay in sync.** A live drummer doesn't hold one tempo, so a straight beat grid slides off the music (by about a tenth of a second on the test tracks). Such tracks are now found when they are analysed and their beats are followed through the whole song (`warp.js`); Sync, loops, beat jump and quantize all use the followed beats (`beatgrid.js`). Measured on real songs through the app's own audio output, the two decks' hits land within 10 ms of each other, drifting tracks included.
- **Wrong BPM? One button.** If the analysis read a track at the wrong level (say 97.5 for a 130 track), **Alt** next to the BPM steps through the other readings. Sync tells you when it had to stretch a track a long way, which is the sign of that.
- **Key matching rewritten** (`key.js`): one small module for key names, the Camelot wheel, key fit and Key Match. Same behaviour as described below.
- **Cleaner, smoother waveforms.** The scrolling waveform is drawn once and slid, instead of being redrawn from the audio data on every frame; it moves on a steady clock rather than the jittery audio clock; and nothing is allocated per frame, so there are no garbage-collection hitches. Meters and readouts only touch the page when their value changes.
- **Faster track loading.** One analysis pass instead of three, the audio handed to the analysis thread without copying, and the four stem files read at the same time.
- **Faster AI stems.** On an NVIDIA card the separator now stays running with its models loaded, instead of starting Python and loading both models again for every track (it closes after ten idle minutes). On the processor it uses up to 8 threads on bigger chips, where it was fixed at 4.
- **Audio buffer setting** (⚙ Settings → Audio & display): *Low delay*, *Balanced* or *Stable*. If audio crackles when the computer is busy, pick Stable. The window also keeps full speed when it is covered or minimised.
- Tracks are analysed again the first time each is loaded after this update.
- Tests: `test/real-sync.js` plays real songs on two decks, records what each deck sends out and measures how far apart the hits are; `test/stems-gpu.js` checks the keep-alive separator with a stand-in for the models. The sync harness still measures under a quarter of a millisecond in all 10 scenarios.

### Linux

- **Linux builds (x64 and ARM64).** The release workflow attaches `OscarDJ-<version>-linux-x64.tar.gz` and `-linux-arm64.tar.gz` next to the Windows and macOS zips. Unpack one and run `OscarDJ.sh`; `install-desktop-entry.sh` adds it to the app menu. yt-dlp and the AI stems runtime are bundled as on the other platforms. `npm run package:linux-x64` builds the same folder from source.

### Sturdier behind the scenes

- **Download errors say what went wrong.** Any yt-dlp error containing the letters "age" (page, message, image…) was reported as "YouTube wants a sign-in". Only real age / sign-in errors are now.
- **macOS:** closing the window while a download or stem job was running no longer throws when it reports progress, and the fullscreen button shows the right state.
- Two decks asking for the same music video share one download; a stem separator that stops unexpectedly fails its jobs instead of leaving them waiting; the GPU stems path looks for `bin/python` off Windows.
- Tests run on every push and pull request (`.github/workflows/test.yml`).

### Matching, and a simpler codebase

Everything that was there still is.

- **Key Match goes for the nearest key that mixes.** It used to move a deck all the way to the other deck's key, up to 6 semitones, which sounds unnatural. Now it takes the smallest shift that lands on the same notes (same or relative key), or one step round the Camelot wheel when that saves more than a semitone: 3 semitones at most, 1.25 on average over every pair of keys (was 6 and 3). The notes the tracks actually play still have the last word, so a wrong key reading doesn't send it somewhere sour. **Shift-click Match** for the very same key.
- **Key Match tunes, too.** Records are often 10–40 cents off concert pitch, and two tracks a quarter-tone apart clash even in the "same" key. Each track's tuning is now measured with its key, and Match takes the difference out. (Keys are read again the first time each track is loaded.)
- **Key fit at a glance.** A dot by each deck's key: green = in key with the other deck (same or relative), a green ring = one step round the wheel, red = a clash. It follows key shift, and tempo without key lock.
- **The library shows what mixes.** Against the deck on air, a green BPM is within 6% (also at half or double time) and a green key fits. **Match** (next to the filter) puts the best fits first, and every column heading sorts.
- **Tempo match without the lock.** Shift-click **Sync** (or `Shift`+`C` / `Shift`+`.`) takes the other deck's tempo once, at ½×, 1× or 2×, and leaves the beat-matching to you.
- **Beat-match meter.** Next to the bar counter, a dot shows how far a deck's beats are from the other deck's, in milliseconds: middle and green = together. It works with Sync off, for matching by hand, and shows Sync holding when it's on.
- **Fixed:** the key readout didn't follow a tempo change made by Sync (without key lock a new tempo is a new pitch), and double-clicking the crossfader left the 4-deck puck behind.
- **Simpler code.** The 2,500-line `app.js` is now a 50-line entry point and one module per area in `src/renderer/ui/`; the matching maths lives in `src/renderer/match.js` and `src/renderer/key.js` with their own tests. Repeated code (saved settings, segmented buttons, link handling) is shared, and unused code is gone.
- Tests: `npm test` now also runs `test/match.test.mjs` (tempo match, key fit, Key Match over all 576 key pairs, tuning, the beat-match meter).

## What's new in 0.3.11-beta

- Full-track preparation reuses the onset envelope for tempo detection and sync, skips cached key analysis, and transfers waveform data without copying it. Manual ×2/÷2 grid fitting also runs in the worker.
- Waveforms no longer allocate and sort an array of bands or allocate a range array for every pixel. Paused decks redraw when their waveform, cues, grid, zoom, theme or size changes. Very short tracks and the last waveform column remain visible.
- Cached AI stems use the same background file reader and serial decode queue as tracks. Cached music videos stream from disk instead of being copied into memory through IPC.
- The audio worklet uses half-sized overlap buffers and skips overlap-add calculations for silence, preserving its 2048-sample delay. Muting all stems now also mutes transients between the old silence-check sample positions; invalid stem gains cannot poison the audio.
- Master volume also controls sound pads. Gate division changes and oscillator cleanup live in the engine. Bulk file imports deduplicate with a set and insert once; unsafe or duplicate library IDs are rejected before cache paths are used.
- Previous local transport, key-match, sync and loading fixes are included. No new runtime dependencies or changes to library locations.

Validation: `npm test`, `npm run test:ui`, `npm run test:load`, `npm run test:fx`, and `npm run test:audio -- --out out/sync.json`. `node test/benchmark.mjs 245e00b` compares the waveform/audio hot loops with the upstream baseline and writes `out/benchmark.json`; timings are informational and vary by machine.

## What's new in 0.3.10-beta

- Track drops prepare waveforms, beat data and scratch samples in a background worker. Audio reads avoid sending whole files through IPC, and PCM copies yield between small chunks. Failed or stalled preparation reports an error instead of switching to heavy work on the UI thread.
- Waveforms follow resize notifications instead of forcing page layout on every animation frame.
- New AI stem separation starts only when you click **Prepare AI stems**, one loaded track at a time. Cached AI stems still load automatically; the instant stem controls work while new AI stems are unprepared.
- Added a full-length stereo drag-and-drop regression with rapid track replacement, plus worker recovery, timeout and sample-transfer tests. Run it with `npm run test:load`.

## What's new in 0.3.9-beta

- Tempo changes and nudges preserve the current playback position. Enabling key processing or loading AI stems no longer starts a cued deck before its scheduled beat.
- Match compensates the tuning of both recordings, including records recorded slightly sharp or flat. Key analysis refreshes once on first load. Match updates pitch and lock together.
- Sync respects manually set grids, listens to the section actually playing after a seek, and honours a forced ratio when the playing deck leads. It shows **TEMPO** if it can keep tempo but has lost beat alignment; press twice to retry after checking the grid.
- Rapid track loads keep the latest selection. Losing window focus releases nudges. Four-deck peak meters work on C and D. An unreadable or damaged library is left untouched and reported at startup.
- Playback regression checks now cover the real engine, renderer and IPC, with audio alignment tests that fail when timing exceeds their limits. The Windows build tooling no longer includes the vulnerable ZIP extractor.

## What's new in 0.3.8-beta

- **Sync rebuilt from scratch.** Every synced deck locks to one shared clock (the way Mixxx and Ableton Link do it), and a phase lock keeps them together with tiny, inaudible speed trims, so decks never drift apart. Sync picks ½×, 1× or 2× once (the ratio button: Auto / ½× / 1× / 2×) and never flips it mid-mix.
- **Synced decks stay synced** through play from pause (a cued deck comes in on the next beat, or the next bar when cued on beat 1), hot cues, seeking, loops, key lock, tempo moves and the space bar. Nudges stick.
- **New beat detection.** Tempo is read far more reliably (92% of the test library within 1% of the published tempo, up from 66%), beat grids are fitted through the whole track (no drift), open hi-hats no longer put the grid on the off-beat, and the other likely tempo readings are kept. Older grids are re-analysed the first time a track is loaded, unless you set them by hand. Analysis runs in the background.
- **Engine timing:** audio runs at 48 kHz (was the device's 192 kHz), every start and jump is scheduled sample-exactly, and key-locked decks no longer slip when their tempo changes.
- **Load over a playing deck**, dials reset on load, and the tempo-range picker is gone from under the slider.
- **Sync listens.** Pressing Sync weighs every tempo reading the analysis found (a triplet or half-time feel can be read at the wrong level) against how firmly each grid sits on the track's hits, and picks the one that needs the least stretching. It then checks where each track's hits really fall: a grid that sits clearly off its music is corrected on joining, and a track that drifts against its own grid (a live drummer) is followed in inaudible steps. Sync also stays on when you load a new track onto a synced deck.
- **Key Match by ear.** Match compares the notes the two tracks actually play and picks the shift where they agree best, instead of trusting key names.
- **Accurate keys.** Key detection measures each track's tuning and weighs notes at their true loudness: on a set of songs with known keys it gets 9 of 11 exact and the other 2 one step away (was 4 exact). Keys are found again the first time each track is loaded.
- **Three-colour waveforms**, as in djay and Serato: bass in red, mids in amber, highs in white, so kicks, snares and hats are easy to tell apart.
- **Smoother look:** softer panels, rounder corners, quieter controls, tinted hot cues and stem dots; Sync lights up in the deck colour.
- Tests: `npm test` (analysis + sync clock), `electron --background test/sync-harness/run.cjs` (measures what each deck actually plays: 0 ms error in all 10 scenarios) and `electron --background test/library-eval.cjs` (tempo accuracy against `test/ground-truth.json`).

## What's new in 0.3.7-beta

- **Fixed: crash when a new track starts AI stems** (for example when you drag a song in). The AI stem runtime now ships next to the app instead of inside it, so Windows no longer loads its own older onnxruntime.dll by mistake.

## What's new in 0.3.6-beta

- **Music video in the middle:** 2 decks put it in a rounded cutout at the top centre above the crossfader; 4 decks put it in a large square where the four decks' inner corners meet, over the XY pad.
- **Waveforms** scroll at the same speed on every deck (16 seconds shown by default; **Settings → Seconds shown**).
- **Snap** lands on the nearest grid line drawn on the waveform (down to ⅛ or ⅟₁₆ beat when zoomed in), lined up with the other deck.
- **Sync** fixes tracks read at ¾ of their tempo (like 112 vs 150): the slower BPM is corrected by 4⁄3 and saved, then the decks sync at normal speed.

## What's new in 0.3.4-beta

- **Snap to beat:** Off / 1 / 1/2 / 1/4. Dragging the waveform, record or overview, and pressing play, land on the nearest step lined up with the other deck.
- **Zoom in beats:** waveform zoom is set as beats shown (4–64, in Settings; `-` / `+` halve or double it), so synced decks line up beat for beat.
- **4-deck XY pad:** in 4-deck mode the crossfader becomes an XY pad (A B on top, C D at the bottom). Compact decks hide the artist line to fit.
- **Hot cues** show their timestamp on the pad and stay visible in 4-deck mode.
- **DROP removed:** the Drop button, V / N keys and riser are gone.

## What's new in 0.3.3-beta

- **Mist theme:** a softer bright theme (soft grey, off-white panels, slate text) in **⚙ Settings**.
- **Fullscreen** (button and F11) now fullscreens the app window, so the Settings dialog stays on top instead of getting stuck behind the page.
- **Tidier Settings:** theme cards fit on one row, with more space between sections.
- **Clean key lock:** key lock and key shift use Signalsmith Stretch, so changing the tempo with key lock on no longer warbles. Its delay is compensated, so sync, loops and Drop stay on the beat.
- **Sync locks tempos:** press **Sync** and the decks stay tempo-locked. Change either one's tempo and the other follows. Press **Sync** again (or load a new track) to unlock.

## What's new in 0.3.2-beta

- **4 decks:** every deck keeps its key row (key readout, key shift, Lock and **Match**) in 4-deck mode; waveforms and mixer faders are a little shorter so the library still fits.

## What's new in 0.3.1-beta

- **4 decks:** ⚙ Settings → Decks switches between 2 and 4 decks. C and D get their own waveform, deck and mixer channel (mixer order C · A · B · D); A and C play on the crossfader's left, B and D on its right. Sync and Match follow a playing deck on the other side.
- **Settings → Audio & display:** pick the output device (headphones, speakers, HDMI…), master volume, and fullscreen (also F11).
- **Spotify search fixed:** Spotify now returns at most 10 results per request; searches page through 50 again, and Spotify's own error text is shown if something's wrong.
- **Polish:** empty decks dim their controls, decks C and D fade in, smoother scrolling.

## What's new in 0.3.0-beta

- **Look:** one clean theme set, picked in **⚙ Settings**: Midnight (dark), Aloe (bright green) and Cherry. Cherries throughout.
- **Records:** a turntable on each deck you can grab and scratch, with real scratch sound. Dragging the waveform scratches too; a flick on a paused deck glides.
- **Bars and sync:** time signature (3/4 or 4/4) and beat 1 are detected per track; **Sync** lines up bars, not just beats. A bar counter shows where you are (`bar 3 · ●●●○`), and **Beat 1** / **4/4** fix the grid by hand.
- **DROP** (V / N): one press builds up over the next bar or two (loop roll 1 → ⅛ beat, high-pass sweep, noise riser) and drops on beat 1, with the track carrying on exactly in time (slip mode). Press again to cancel.
- **SFX tab:** ten dubstep / dariacore one-shots (air horn, dub siren, laser, sub drop, wobble, riser, rewind and more), synthesized live, optionally quantized to the beat.
- **AI stems:** real model-separated vocals / drums / instruments. With an NVIDIA GPU and the optional PyTorch setup (see `src/stems-gpu.py`), MelBand RoFormer + HT-Demucs fine-tuned run on the GPU (~1 minute per track); otherwise HT-Demucs runs on the CPU (**Get AI stems** downloads its model). DSP stems stay as the instant fallback.
- **Search:** a **YouTube / Spotify** switch. Spotify searches the catalogue (needs a free app key) and fetches the matching YouTube upload for the audio.
- **Space bar** pauses everything and resumes the same decks; smoother zoom, animations, and a desktop launcher (`Start OscarDJ.cmd`).

## Running it

**Windows:** pick `OscarDJ-<version>-win-x64.zip` for most PCs or `OscarDJ-<version>-win-arm64.zip` for Windows on ARM.

1. Unzip it somewhere you keep apps, such as `Documents\Apps\OscarDJ`.
2. Double-click **OscarDJ.exe**.
3. The app isn't code-signed, so Windows SmartScreen will warn you the first time. Click **More info → Run anyway**.

**macOS:** unzip `OscarDJ-<version>-mac-universal.zip` (Apple Silicon and Intel) and drag **OscarDJ.app** to
Applications. It isn't notarized, so the first time **right-click the app → Open → Open**.

**Linux:** extract `OscarDJ-<version>-linux-x64.tar.gz` (or `-linux-arm64`) and run `OscarDJ.sh` inside it. Run
`install-desktop-entry.sh` once to add OscarDJ to your app menu.

Your library and downloads live in `%APPDATA%\OscarDJ` on Windows, `~/Library/Application Support/OscarDJ` on macOS and
`~/.config/OscarDJ` on Linux (the **Open download folder** button takes you there).

## What it does

- **Two or four decks** with play/cue, 4 hot cues, beat loops (1/2/4/8), tempo slider (±8/16/50%), nudge, and **SYNC** that matches tempo and beat phase.
- **Automatic BPM and beat grid** detection on first load, with ÷2 / ×2 / TAP / BEAT to fix the grid by hand.
- **Key detection** (Camelot + key name), **key shift** (♭/♯ without changing tempo), **key lock** (tempo without changing pitch) and **MATCH** to put a deck in a key that mixes with the other deck's, tuned to it.
- **Stems**: turn vocals, drums or instruments on and off per deck in real time (DSP separation, approximate — see `docs/new-features/key-and-stems.md`).
- **AI stems (prototype)**: with the HT-Demucs model and ONNX Runtime installed, click **Prepare AI stems** to process the loaded tracks one at a time. Cached stems load automatically, and the stem buttons switch to the AI stems when ready — see `docs/new-features/ai-stems-plan.md`.
- **Mixer** with trim, 3-band EQ (kills at the bottom), one-knob filter (left = low-pass, right = high-pass), channel faders with meters, a crossfader with Blend or Cut curves, and a limiter on the master.
- **Scrolling waveforms** that stay beat-aligned across both decks, plus an overview you can click to seek.
- **Library** for your own files (drag them into the window or use Add files), sortable by any column, with marks for the tracks that fit the deck on air in tempo and key.
- **YouTube and Spotify search**, with YouTube audio downloaded through yt-dlp. This development build does not filter by license. You can also paste a link.
- ~~**License gate**~~: removed in this build (see `docs/license-gate-features/`).
- **Credits**: collects attribution lines for every CC track you play, ready to paste into a mix description (CC BY requires credit).

## Keyboard

| Deck A | Deck B | Mixer |
|---|---|---|
| `X` play / pause | `,` play / pause | `←` `→` crossfader |
| `Z` cue | `M` cue | `Shift` + arrows: slam |
| `C` sync | `.` sync | `/` filter library |
| `Shift`+`C` match tempo only | `Shift`+`.` match tempo only | |
| `1`–`4` hot cues | `7`–`0` hot cues | `?` help |
| `Q` / `W` nudge | `O` / `P` nudge | |

Shift + a hot cue key clears it.

## yt-dlp

A copy of the official `yt-dlp_arm64.exe` ships inside the app. The **yt-dlp** chip in the top bar shows its version; click it to update. YouTube changes often, so update yt-dlp first if search or downloads stop working.

YouTube support in yt-dlp needs a JavaScript runtime. OscarDJ provides one by reusing its own built-in Node.js, so there's nothing extra to install. If you already have Deno installed, yt-dlp will use that instead.

## Building from source

Requires Node.js 22.12 or newer.

```
npm install
npm run fetch-ytdlp     # grabs yt-dlp for this computer, so `npm start` works
npm start               # run in development
npm test                # analysis, sync clock, matching, transport, worker and library regressions
npm run test:ui          # real UI with a disposable library, no audio output
npm run test:load        # full-length stereo drag-and-drop responsiveness
npm run test:fx          # offline renders through the real audio worklet
npm run test:audio       # recorded deck alignment; takes several minutes
npm run package:win-arm64
npm run package:win-x64
npm run package:linux-x64
```

Project layout:

- `src/main.js` handles the window, library storage, and yt-dlp (search and download).
- `src/preload.js` is the bridge between the UI and the main process.
- `src/renderer/engine.js` is the Web Audio engine (decks, EQ, filter, loops, crossfader).
- `src/renderer/sync.js` is the sync clock every synced deck locks to.
- `src/renderer/beatgrid.js` is a track's beats: where each one falls, also when the tempo wanders.
- `src/renderer/warp.js` finds tracks with a wandering tempo and follows their beats.
- `src/renderer/key.js` is everything about keys: names, the Camelot wheel, key fit, Key Match.
- `src/renderer/match.js` is tempo matching (½×, 1×, 2×) and the library's mix-fit score.
- `src/renderer/deck-fx.worklet.js` is the per-deck audio-thread processor for key shift / key lock / stems.
- `src/renderer/analysis.js` holds the waveform, BPM/beat-grid and key detection.
- `src/renderer/app.js` starts the UI, which lives in `src/renderer/ui/`:
  `core.js` (shared state and helpers), `deck.js`, `mixer-ui.js`, `waves.js` (waveforms and the frame loop),
  `sync-ui.js` (Sync, tempo match, Key Match, snap), `grid.js` (hot cues and beat-grid fixes), `load.js`
  (decoding, analysis, AI stems), `library.js`, `search.js`, `video.js`, `settings.js`, `keyboard.js`, `knob.js`.

## Notes and limits

- Tempo changes work like vinyl (pitch moves with speed) unless **LOCK** is on.
- Key shift and stems run through a per-deck processor that adds a fixed ~43 ms delay to both decks.
- There's one audio output, so there's no separate headphone cue yet.
- Decoded audio is held in memory, so very long files (hour-long mixes) use a lot of RAM.
- This development build does not verify licenses. Check the source license for anything you plan to publish.

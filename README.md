# ASCII World

**Live:** https://vishnuvsdevtech.github.io/ascii-world/

A glyph-grid world you can walk: hills, a grass field, and a character with
verlet hair. Two controls — arrow keys / WASD to walk, Shift to run — and one
toggle that puts the whole thing on a **2.9" 296×128 e-paper panel**.

## Three ideas carry it

**1. Grass is a function, not data.** A blade's position, height and lean are a
hash of `(column, index)`. Nothing is stored, nothing is simulated off-camera,
and the world has no edge — it is evaluated for the columns on screen and
forgotten. That is how a field of hundreds of thousands of blades costs zero
memory.

**2. Draw per row, not per cell.** A monospace grid means a row is one string.
Cells are bucketed into brightness levels, contiguous runs become a single
`fillText`, and a 150×56 grid lands in a few hundred draw calls instead of
~8,000 glyph blits. The HUD shows the live run count so the claim is checkable.

**3. Hair is verlet.** Twelve strands, four segments, integrated against gravity
plus wind plus the walk cycle, with a length constraint per segment. The same
integrator a grass tuft would use — which is why a few hundred hair nodes cost
nothing next to the field.

## E-paper mode

The `e-paper 296×128` toggle re-grids to **49×16 cells** (6×8 px per glyph on a
296×128 panel), flips to a 1-bit palette where brightness becomes *ink density*
rather than alpha, and refreshes at **3 fps** — the honest frame rate of a
partial-refresh e-paper panel. No scanlines, no glow.

That mode is the point of the project: characters are what e-paper renders
perfectly. A glyph cell is crisp at any size, needs no greyscale or dithering,
and holds with the power off.

## Honest limits

- Blades are procedural, so "capacity" is `world × blades-per-column`, not a
  count of objects in memory. The HUD labels it as capacity.
- The character is 5 cells tall by design: at 49 columns there is no room for
  more, and adding detail above 5 rows breaks legibility at that grid size.
- Hair collision with the body is ignored; strands can clip through the torso at
  high speed. Visible only when running.

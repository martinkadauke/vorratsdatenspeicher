# 🔫 SNIPY

**The endless barrel-multiplier horde shooter — the mobile ad game that's actually real.**

You stand at the bottom of the road. Enemies pour down at you, endlessly. You never stop shooting. Blast the **×2 / ×10 barrels** to multiply your bullets, crack open **weapon crates** to swap guns, and see how long you can hold the line.

No install, no build step, no dependencies. It's one HTML file and two friends.

## Play

Just open `index.html` in any modern browser — desktop or phone.

Or serve it (nicer on mobile / needed for GitHub Pages):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

**GitHub Pages:** push this repo, enable Pages on the default branch (`/root`), and it's live at `https://<user>.github.io/snipy/`.

## Controls

| | |
|---|---|
| **Move** | Drag anywhere (touch) or hold and move the mouse |
| | Arrow keys / `A` `D` (desktop) |
| **Fire** | Automatic — you're always shooting |
| **Start / retry** | Tap the button, or press `Space` |

## How it works

- **Barrels** `×2 ×3 ×5 ×10` (and `+5 +10 +25`) fall toward you. Shoot one to destroy it and **multiply your firepower**. This is the whole game — chain them and your bullet count explodes.
- **Crates** `?` drop weapons: **SMG, Shotgun, Minigun, Rockets**. Shoot one to equip it for ~14s, then you fall back to the trusty Pistol.
- **Enemies** — grunts, fast pinks, and beefy tanks — walk down the road. Killing them scores points; letting one reach you costs a ❤️. Lose all three and it's **OVERRUN**.
- Difficulty ramps the whole time: more enemies, tougher enemies, faster. Your job is to out-multiply the horde.

Your best score is saved locally.

## Project layout

```
index.html   — markup, HUD, start/game-over screens
style.css    — all styling
main.js      — the entire game (canvas, no framework)
```

Everything is vanilla JS in a single `requestAnimationFrame` loop. Weapons, enemy types, and barrel odds are plain config objects near the top of `main.js` — easy to tweak.

## Roadmap ideas

- Boss enemies every few waves
- Persistent upgrades / a meta shop between runs
- More weapons (laser, flamethrower, homing drones)
- Barrel **gates** you steer between (pick the bigger multiplier)
- Sound polish and a soundtrack
- Screen-clear bombs

PRs and wild ideas welcome.

---

Built for fun. Vibes based on every phone ad that lied to you. 💥

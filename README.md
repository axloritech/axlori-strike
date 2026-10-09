# AXLORI STRIKE

A local-only, low-poly first-person shooter prototype built with Next.js App Router, TypeScript, and Three.js. The game runs entirely in the browser; it needs no API keys, accounts, database, or multiplayer service.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The playable game is at `/`.

## Controls

### Keyboard and mouse

- **W / A / S / D** — move and strafe
- **Shift** — sprint
- **Space** — jump (grounded only)
- **C** or **Ctrl** — slide while moving forward
- **Left mouse button** — fire (hold for automatic fire)
- **Right mouse button** — aim down sights
- **R** — reload
- **Escape** — pause / resume
- Drag with the mouse if pointer lock is unavailable

### Touchscreen (landscape layout)

- Left virtual stick — move; **RUN** toggles sprint
- Drag in the open right-hand area — look
- **FIRE**, **JUMP**, **SLIDE**, **AIM**, and **RLD** — combat actions
- Touch buttons are separate from the look surface so tapping them does not rotate the camera

The game requests landscape orientation when the browser allows it. If it cannot lock orientation, portrait play shows a rotate-device prompt that clears when the screen returns to landscape.

## Implementation notes

- Three.js renderer and game engine are imported/created in a client-side effect; they are not run during server rendering.
- The enclosed arena, first-person rifle, humanoid bots, hit rays, and tracer are generated from low-poly geometry.
- Movement and obstacle collision use a small custom AABB controller rather than a physics dependency. Bots use short-range detection/chase/attack states with a simple side-step around cover.
- Weapon state includes a 30-round magazine, 90 reserve rounds, automatic fire-rate gating, raycast hits, damage, headshot bonus, reload timing, recoil, muzzle flash, weapon bob, aim FOV, and touch/mouse support.
- Web Audio oscillator effects are created only after interaction. Rendering is capped at 1.4× device pixel ratio; real-time shadows and post-processing are intentionally omitted.
- This is a prototype: bot navigation is not a full navmesh, and PWA/offline support is not included.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
npm audit
```

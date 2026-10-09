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

- Left virtual joystick — variable-speed movement; push forward near the edge to sprint automatically
- Drag in the open right-hand area — look
- **FIRE** — hold for automatic fire; **JUMP**, **SLIDE**, **AIM**, and **RELOAD** remain usable while moving
- Touch buttons are separate from the look surface so pressing them does not rotate the camera
- Slide requires forward movement, keeps momentum briefly, and has a short cooldown

The game requests landscape orientation when the browser allows it. If it cannot lock orientation, portrait play shows a rotate-device prompt that clears when the screen returns to landscape.

## Implementation notes

- Three.js renderer and game engine are imported/created in a client-side effect; they are not run during server rendering.
- The industrial training yard, ribbed containers, concrete barriers, command tower, first-person carbine, humanoid bots, hit rays, and hit sparks are generated from low-poly geometry.
- Movement and obstacle collision use a small custom AABB controller rather than a physics dependency. The joystick has a dead zone, variable-speed response, and automatic sprint threshold; bots use short-range detection/chase/attack states with a simple side-step around cover. Bounded elapsed-time timers preserve reload/fire cadence on slow frames, and player collision is sub-stepped to avoid tunneling during sprint and slide movement.
- Weapon state includes a 30-round magazine, 90 reserve rounds, continuous fire while held, raycast hits, damage, headshot bonus, reload timing, recoil, muzzle flash, weapon bob, smooth aim FOV, and touch/mouse support. The HUD radar tracks nearby active bots.
- Web Audio oscillator effects are created only after interaction. Rendering is capped at 1.25× device pixel ratio; a single low-resolution shadow map is limited to non-coarse pointers, while touch layouts use inexpensive contact-shadow planes.
- This is a prototype: bot navigation is not a full navmesh, and PWA/offline support is not included.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
npm audit
```

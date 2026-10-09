'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArenaGame, GameEvent, GameSnapshot } from '@/lib/game/ArenaGame';

const INITIAL_SNAPSHOT: GameSnapshot = {
  mode: 'menu',
  health: 100,
  maxHealth: 100,
  ammo: 30,
  reserve: 90,
  kills: 0,
  aiming: false,
  reloading: false,
  sprinting: false,
};

type Point = { x: number; y: number };

export default function AxloriStrike() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<ArenaGame | null>(null);
  const joystickRef = useRef<HTMLDivElement>(null);
  const joystickPointerRef = useRef<number | null>(null);
  const lookPointerRef = useRef<number | null>(null);
  const lastLookPointRef = useRef<Point>({ x: 0, y: 0 });
  const flashTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const [snapshot, setSnapshot] = useState<GameSnapshot>(INITIAL_SNAPSHOT);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [stickPoint, setStickPoint] = useState<Point>({ x: 0, y: 0 });
  const [hitVisible, setHitVisible] = useState(false);
  const [hurtVisible, setHurtVisible] = useState(false);
  const [killToast, setKillToast] = useState(false);
  const [portraitTouch, setPortraitTouch] = useState(false);
  const [gameReady, setGameReady] = useState(false);
  const [gameError, setGameError] = useState('');

  const showTimedFlag = useCallback((setter: (value: boolean) => void, duration: number) => {
    setter(true);
    const timer = setTimeout(() => {
      setter(false);
      flashTimersRef.current = flashTimersRef.current.filter((scheduled) => scheduled !== timer);
    }, duration);
    flashTimersRef.current.push(timer);
  }, []);

  const handleGameEvent = useCallback((event: GameEvent) => {
    if (event.type === 'hit') showTimedFlag(setHitVisible, 125);
    if (event.type === 'damage') showTimedFlag(setHurtVisible, 330);
    if (event.type === 'kill') showTimedFlag(setKillToast, 1050);
  }, [showTimedFlag]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let engine: ArenaGame | null = null;
    let cancelled = false;
    const initializeGame = async () => {
      try {
        // Import Three.js only in the browser after mount; nothing from the renderer runs in SSR.
        const { ArenaGame: Game } = await import('@/lib/game/ArenaGame');
        if (cancelled) return;
        engine = new Game(canvas, setSnapshot, handleGameEvent);
        gameRef.current = engine;
        setSnapshot(engine.getSnapshot());
        setGameError('');
        setGameReady(true);
      } catch (error) {
        if (cancelled) return;
        const details = error instanceof Error ? error.message : 'WebGL could not be initialized.';
        setGameError(`The 3D arena could not start. Try a browser with WebGL enabled. (${details})`);
      }
    };
    void initializeGame();

    const updateOrientation = () => {
      const isTouch = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
      setPortraitTouch(isTouch && window.innerHeight > window.innerWidth);
    };
    updateOrientation();
    window.addEventListener('resize', updateOrientation, { passive: true });
    window.addEventListener('orientationchange', updateOrientation, { passive: true });

    return () => {
      cancelled = true;
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      if (gameRef.current === engine) gameRef.current = null;
      engine?.dispose();
      for (const timer of flashTimersRef.current) clearTimeout(timer);
      flashTimersRef.current = [];
    };
  }, [handleGameEvent]);

  const startGame = () => {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (value: 'landscape') => Promise<void> };
    if (typeof orientation?.lock === 'function') {
      void orientation.lock('landscape').catch(() => undefined);
    }
    void gameRef.current?.start(soundEnabled);
  };

  const toggleSound = () => {
    const enabled = !soundEnabled;
    setSoundEnabled(enabled);
    gameRef.current?.setSoundEnabled(enabled);
  };

  const handleJoystickMove = (clientX: number, clientY: number) => {
    const element = joystickRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const radius = rect.width * 0.37;
    let x = (clientX - (rect.left + rect.width / 2)) / radius;
    let y = (clientY - (rect.top + rect.height / 2)) / radius;
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    setStickPoint({ x, y });
    gameRef.current?.setMovementStick(x, y);
  };

  const onJoystickPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    joystickPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    handleJoystickMove(event.clientX, event.clientY);
  };

  const onJoystickPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    handleJoystickMove(event.clientX, event.clientY);
  };

  const endJoystick = (event: React.PointerEvent<HTMLDivElement>) => {
    if (joystickPointerRef.current !== event.pointerId) return;
    joystickPointerRef.current = null;
    gameRef.current?.setMovementStick(0, 0);
    setStickPoint({ x: 0, y: 0 });
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onLookPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    event.preventDefault();
    lookPointerRef.current = event.pointerId;
    lastLookPointRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onLookPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lookPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const previous = lastLookPointRef.current;
    gameRef.current?.lookBy(event.clientX - previous.x, event.clientY - previous.y);
    lastLookPointRef.current = { x: event.clientX, y: event.clientY };
  };

  const endLook = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lookPointerRef.current !== event.pointerId) return;
    lookPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const stopPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const healthPercent = Math.max(0, Math.min(100, (snapshot.health / snapshot.maxHealth) * 100));
  const mobileControlsEnabled = snapshot.mode === 'playing';

  return (
    <main className="game-shell" aria-label="Axlori Strike first-person shooter">
      <canvas ref={canvasRef} className="game-canvas" aria-label="3D training arena" />
      <div className="scene-vignette" aria-hidden="true" />
      <div className={`damage-flash${hurtVisible ? ' is-visible' : ''}`} aria-hidden="true" />

      {snapshot.mode === 'playing' && (
        <>
          <section className="hud" aria-label="Game status">
            <div className={`health-card${snapshot.health <= 32 ? ' is-critical' : ''}`}>
              <div className="hud-caption"><span className="status-dot" /> OPERATIVE STATUS</div>
              <div className="health-reading">
                <span>VITALS</span>
                <strong>{snapshot.health}<small> / {snapshot.maxHealth}</small></strong>
              </div>
              <div className="health-track"><i style={{ width: `${healthPercent}%` }} /></div>
            </div>

            <div className="hud-right-top">
              <div className="kill-card">
                <span className="hud-caption">TARGETS DOWN</span>
                <strong>{String(snapshot.kills).padStart(2, '0')}</strong>
              </div>
              <button className="hud-icon-button sound-hud" onClick={toggleSound} aria-label={soundEnabled ? 'Mute sound' : 'Enable sound'}>
                <span className={`sound-glyph${soundEnabled ? '' : ' is-muted'}`} aria-hidden="true" />
                <span className="hud-button-label">{soundEnabled ? 'SOUND' : 'MUTED'}</span>
              </button>
              <button className="hud-icon-button pause-hud" onClick={() => gameRef.current?.pause()} aria-label="Pause game">
                <span className="pause-glyph" aria-hidden="true"><i /><i /></span>
                <span className="hud-button-label">PAUSE</span>
              </button>
            </div>

            <div className="ammo-card" aria-live="polite">
              <div className="ammo-status">{snapshot.reloading ? 'RELOADING' : 'AX-7 / AUTO'}</div>
              <div className="ammo-reading"><strong>{String(snapshot.ammo).padStart(2, '0')}</strong><span> / {String(snapshot.reserve).padStart(2, '0')}</span></div>
              <div className="ammo-label">MAGAZINE <b>·</b> RESERVE</div>
            </div>
          </section>

          <div className={`crosshair${snapshot.aiming ? ' is-aiming' : ''}${hitVisible ? ' is-hit' : ''}`} aria-hidden="true">
            <i className="crosshair-top" /><i className="crosshair-right" /><i className="crosshair-bottom" /><i className="crosshair-left" />
            <b />
          </div>
          {snapshot.aiming && <div className="aim-overlay" aria-hidden="true"><span /><i /></div>}
          {hitVisible && <div className="hit-confirmation" aria-label="Hit confirmed"><i /><i /><i /><i /></div>}
          {killToast && <div className="kill-toast"><span /> TARGET NEUTRALIZED <b>+1</b></div>}

          <div
            className="touch-look-pad"
            aria-hidden="true"
            onPointerDown={onLookPointerDown}
            onPointerMove={onLookPointerMove}
            onPointerUp={endLook}
            onPointerCancel={endLook}
            onLostPointerCapture={endLook}
          />

          <div className={`touch-controls${mobileControlsEnabled ? ' is-active' : ''}`} aria-label="Touch gameplay controls">
            <div
              ref={joystickRef}
              className="virtual-joystick touch-control"
              role="application"
              aria-label="Movement joystick. Drag to move."
              onPointerDown={onJoystickPointerDown}
              onPointerMove={onJoystickPointerMove}
              onPointerUp={endJoystick}
              onPointerCancel={endJoystick}
              onLostPointerCapture={endJoystick}
            >
              <span className="joystick-ring" />
              <span className="joystick-cross-x" />
              <span className="joystick-cross-y" />
              <span className="joystick-label">MOVE</span>
              <span className="joystick-knob" style={{ transform: `translate(calc(-50% + ${stickPoint.x * 31}px), calc(-50% + ${stickPoint.y * 31}px))` }} />
            </div>
            <button
              className={`sprint-control touch-control${snapshot.sprinting ? ' is-active' : ''}`}
              onPointerDown={stopPointer}
              onClick={() => gameRef.current?.toggleSprint()}
              aria-pressed={snapshot.sprinting}
            >RUN</button>
            <div className="action-cluster">
              <button
                className="action-button action-slide touch-control"
                onPointerDown={stopPointer}
                onClick={() => gameRef.current?.beginSlide()}
                aria-label="Slide"
              >SLIDE</button>
              <button
                className={`action-button action-aim touch-control${snapshot.aiming ? ' is-active' : ''}`}
                onPointerDown={stopPointer}
                onClick={() => gameRef.current?.toggleAim()}
                aria-pressed={snapshot.aiming}
                aria-label="Aim down sights"
              >AIM</button>
              <button
                className="action-button action-reload touch-control"
                onPointerDown={stopPointer}
                onClick={() => gameRef.current?.startReload()}
                aria-label="Reload weapon"
              >RLD</button>
              <button
                className="action-button action-jump touch-control"
                onPointerDown={stopPointer}
                onClick={() => gameRef.current?.pressJump()}
                aria-label="Jump"
              >JUMP</button>
              <button
                className="action-button action-fire touch-control"
                onPointerDown={(event) => {
                  stopPointer(event);
                  if (event.pointerType === 'mouse' && event.button !== 0) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  gameRef.current?.setFiring(true);
                }}
                onPointerUp={(event) => {
                  stopPointer(event);
                  gameRef.current?.setFiring(false);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => gameRef.current?.setFiring(false)}
                onLostPointerCapture={() => gameRef.current?.setFiring(false)}
                aria-label="Fire weapon"
              ><span className="fire-core" /><b>FIRE</b></button>
            </div>
          </div>
        </>
      )}

      {snapshot.mode === 'menu' && (
        <div className="menu-layer">
          <section className="menu-panel">
            <div className="menu-kicker"><i /> LOCAL TRAINING SIM <span>01 / 03</span></div>
            <h1>AXLORI <em>STRIKE</em></h1>
            <p className="menu-subtitle">FIRST-PERSON COMBAT // TRAINING YARD</p>
            <div className="menu-divider"><span /> FIELD EXERCISE: CLEAR THE YARD <span /></div>
            <div className="menu-ready"><span>ARENA STATUS</span><strong><i /> {gameReady ? 'READY' : gameError ? 'OFFLINE' : 'CALIBRATING'}</strong></div>
            <button className="start-button" onClick={startGame} disabled={!gameReady}>
              <span>{gameReady ? 'START GAME' : 'INITIALIZING'}</span><b aria-hidden="true">↗</b>
            </button>
            <div className="controls-guide">
              <div className="guide-heading">FIELD CONTROLS <span>QUICK REFERENCE</span></div>
              <div className="guide-columns">
                <div>
                  <b>KEYBOARD + MOUSE</b>
                  <span><kbd>W A S D</kbd> MOVE <i>·</i> <kbd>SHIFT</kbd> SPRINT</span>
                  <span><kbd>SPACE</kbd> JUMP <i>·</i> <kbd>C</kbd> SLIDE</span>
                  <span><kbd>LMB</kbd> FIRE <i>·</i> <kbd>RMB</kbd> AIM</span>
                  <span><kbd>R</kbd> RELOAD <i>·</i> <kbd>ESC</kbd> PAUSE</span>
                </div>
                <div>
                  <b>TOUCHSCREEN</b>
                  <span>LEFT STICK <i>·</i> MOVE</span>
                  <span>DRAG RIGHT SIDE <i>·</i> LOOK</span>
                  <span>FIRE, AIM, JUMP, SLIDE</span>
                  <span>RUN <i>·</i> SPRINT TOGGLE</span>
                </div>
              </div>
            </div>
          </section>
          <button className="sound-toggle" onClick={toggleSound} aria-label={soundEnabled ? 'Mute sound' : 'Enable sound'}>
            <span className={`sound-glyph${soundEnabled ? '' : ' is-muted'}`} aria-hidden="true" />
            <span>{soundEnabled ? 'SOUND ON' : 'SOUND OFF'}</span>
          </button>
          <div className="menu-build-tag">AXLORI SYSTEMS <i /> PROTOTYPE 01</div>
        </div>
      )}

      {snapshot.mode === 'paused' && (
        <div className="modal-layer">
          <section className="state-panel">
            <div className="menu-kicker"><i /> TRAINING PAUSED</div>
            <h2>HOLD POSITION</h2>
            <p>The yard is waiting. Take a breath, then get back in.</p>
            <div className="state-stats"><span>ELIMINATIONS <b>{String(snapshot.kills).padStart(2, '0')}</b></span><span>VITALS <b>{snapshot.health}%</b></span></div>
            <button className="start-button" onClick={() => gameRef.current?.resume()}><span>RESUME TRAINING</span><b aria-hidden="true">↗</b></button>
            <div className="state-hint">PRESS <kbd>ESC</kbd> TO RESUME</div>
          </section>
        </div>
      )}

      {snapshot.mode === 'dead' && (
        <div className="modal-layer death-layer">
          <section className="state-panel death-panel">
            <div className="menu-kicker"><i /> OPERATIVE DOWN</div>
            <h2>MISSION<br /><em>INTERRUPTED</em></h2>
            <p>Regroup, reload, and re-enter the training yard.</p>
            <div className="state-stats"><span>ELIMINATIONS <b>{String(snapshot.kills).padStart(2, '0')}</b></span><span>VITALS <b className="zero-health">00%</b></span></div>
            <button className="start-button" onClick={() => gameRef.current?.respawn()}><span>RESPAWN</span><b aria-hidden="true">↗</b></button>
          </section>
        </div>
      )}

      {portraitTouch && snapshot.mode === 'playing' && (
        <div className="rotate-overlay">
          <div className="rotate-card"><span className="rotate-device" aria-hidden="true"><i /></span><b>ROTATE YOUR DEVICE</b><p>AXLORI STRIKE is built for landscape play.</p></div>
        </div>
      )}

      {gameError && (
        <div className="error-layer">
          <section className="state-panel error-panel">
            <div className="menu-kicker"><i /> GRAPHICS SYSTEM</div>
            <h2>3D UNAVAILABLE</h2>
            <p>{gameError}</p>
            <button className="start-button" onClick={() => window.location.reload()}><span>TRY AGAIN</span><b aria-hidden="true">↗</b></button>
          </section>
        </div>
      )}
    </main>
  );
}

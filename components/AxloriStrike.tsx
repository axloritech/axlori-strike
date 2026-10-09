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
  radarContacts: [],
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
  const [firePressed, setFirePressed] = useState(false);
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
    if (event.type === 'empty') setFirePressed(false);
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

  const activateAction = (event: React.PointerEvent<HTMLButtonElement>, action: () => void) => {
    stopPointer(event);
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    action();
  };

  const activateKeyboardAction = (event: React.MouseEvent<HTMLButtonElement>, action: () => void) => {
    if (event.detail === 0) action();
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
            <div className="hud-left-group">
              <div className="radar" role="img" aria-label={`${snapshot.radarContacts.length} hostiles nearby`}>
                <span className="radar-ring radar-ring-outer" />
                <span className="radar-ring radar-ring-inner" />
                <span className="radar-axis radar-axis-x" />
                <span className="radar-axis radar-axis-y" />
                <span className="radar-sweep" />
                <i className="radar-player" />
                {snapshot.radarContacts.map((contact, index) => (
                  <i
                    className="radar-contact"
                    key={`${index}-${contact.x.toFixed(2)}-${contact.y.toFixed(2)}`}
                    style={{ left: `calc(50% + ${contact.x * 36}px)`, top: `calc(50% + ${contact.y * 36}px)` }}
                  />
                ))}
              </div>
              <div className="kill-card">
                <span className="hud-caption">KILLS</span>
                <strong>{String(snapshot.kills).padStart(2, '0')}</strong>
              </div>
            </div>

            <div className="hud-right-group">
              <div className={`health-card${snapshot.health <= 32 ? ' is-critical' : ''}`} aria-label={`Health ${snapshot.health} of ${snapshot.maxHealth}`}>
                <div className="health-topline">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 4.9a5.2 5.2 0 0 0-7.4 0L12 6.2l-1.4-1.3a5.2 5.2 0 0 0-7.4 7.4l1.4 1.4L12 21l7.4-7.3 1.4-1.4a5.2 5.2 0 0 0 0-7.4Z" /></svg>
                  <span>HP</span>
                  <strong>{snapshot.health}<small> / {snapshot.maxHealth}</small></strong>
                </div>
                <div className="health-track"><i style={{ width: `${healthPercent}%` }} /></div>
              </div>
              <button className="hud-icon-button sound-hud" onClick={toggleSound} aria-label={soundEnabled ? 'Mute sound' : 'Enable sound'}>
                <span className={`sound-glyph${soundEnabled ? '' : ' is-muted'}`} aria-hidden="true" />
              </button>
              <button className="hud-icon-button pause-hud" onClick={() => gameRef.current?.pause()} aria-label="Pause game">
                <span className="pause-glyph" aria-hidden="true"><i /><i /></span>
              </button>
            </div>

            <div className="ammo-card" aria-live="polite">
              <div className="ammo-status">{snapshot.reloading ? 'RELOADING' : 'AX-7 / AUTO'}</div>
              <svg className="ammo-glyph" viewBox="0 0 48 18" aria-hidden="true"><path d="M2 7h18l5-4h10l3 3h8v4h-7l-4 5H21l-3-4H2zm25-1 4 2-4 2h-4V6z" /><path d="M10 13v3M13 13v3M37 4v2" /></svg>
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
              aria-label="Movement joystick. Drag to move; push forward to sprint."
              onPointerDown={onJoystickPointerDown}
              onPointerMove={onJoystickPointerMove}
              onPointerUp={endJoystick}
              onPointerCancel={endJoystick}
              onLostPointerCapture={endJoystick}
            >
              <span className="joystick-ring" />
              <span className="joystick-cross-x" />
              <span className="joystick-cross-y" />
              <i className="joystick-chevron joystick-chevron-up" />
              <i className="joystick-chevron joystick-chevron-right" />
              <i className="joystick-chevron joystick-chevron-down" />
              <i className="joystick-chevron joystick-chevron-left" />
              <span className="joystick-label">MOVE</span>
              <span className="joystick-knob" style={{ transform: `translate(calc(-50% + ${stickPoint.x * 70}%), calc(-50% + ${stickPoint.y * 70}%))` }} />
            </div>
            <div className={`sprint-indicator${snapshot.sprinting ? ' is-active' : ''}`} aria-live="polite" data-testid="sprint-indicator">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.3 4.5a2 2 0 1 0-2-2 2 2 0 0 0 2 2ZM11 8l-3 4 3.2 2.1-1.1 5.4M11.2 8l4.4 2.4 2.8-.8M9.4 12l-4.2 1.6-1.7 3.1M14.2 13l3.8 3.2 2.1 3" /></svg>
              <span>{snapshot.sprinting ? 'SPRINT ACTIVE' : 'DRAG UP TO SPRINT'}</span>
            </div>
            <div className="action-cluster">
              <button
                className={`action-button action-aim touch-control${snapshot.aiming ? ' is-active' : ''}`}
                onPointerDown={(event) => activateAction(event, () => gameRef.current?.toggleAim())}
                onClick={(event) => activateKeyboardAction(event, () => gameRef.current?.toggleAim())}
                aria-pressed={snapshot.aiming}
                aria-label="Aim down sights"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 1v5m0 12v5M1 12h5m12 0h5M12 9v6m-3-3h6" /></svg>
                <span>AIM</span>
              </button>
              <button
                className="action-button action-fire touch-control"
                onPointerDown={(event) => {
                  stopPointer(event);
                  if (event.pointerType === 'mouse' && event.button !== 0) return;
                  setFirePressed(true);
                  event.currentTarget.setPointerCapture(event.pointerId);
                  gameRef.current?.setFiring(true);
                }}
                onPointerUp={(event) => {
                  stopPointer(event);
                  setFirePressed(false);
                  gameRef.current?.setFiring(false);
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => {
                  setFirePressed(false);
                  gameRef.current?.setFiring(false);
                }}
                onLostPointerCapture={() => {
                  setFirePressed(false);
                  gameRef.current?.setFiring(false);
                }}
                aria-label="Hold to fire continuously"
                data-testid="fire-button"
                aria-pressed={firePressed}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3.4 14.3 7.9-7.9 3.7 3.7-7.9 7.9H3.4zM13 5.7l2.3-2.3 5.3 5.3-2.3 2.3M3.4 14.3l6.3 6.3M6.1 11.6l6.3 6.3" /></svg>
                <span>FIRE</span>
              </button>
              <button
                className="action-button action-jump touch-control"
                onPointerDown={(event) => activateAction(event, () => gameRef.current?.pressJump())}
                onClick={(event) => activateKeyboardAction(event, () => gameRef.current?.pressJump())}
                aria-label="Jump while moving"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V4m0 0L6.5 9.5M12 4l5.5 5.5M5 21h14" /></svg>
                <span>JUMP</span>
              </button>
              <button
                className="action-button action-reload touch-control"
                onPointerDown={(event) => activateAction(event, () => gameRef.current?.startReload())}
                onClick={(event) => activateKeyboardAction(event, () => gameRef.current?.startReload())}
                aria-label="Reload while moving"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6.1 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12-1" /></svg>
                <span>RELOAD</span>
              </button>
              <button
                className="action-button action-slide touch-control"
                onPointerDown={(event) => activateAction(event, () => gameRef.current?.beginSlide())}
                onClick={(event) => activateKeyboardAction(event, () => gameRef.current?.beginSlide())}
                aria-label="Slide while moving forward"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 18 7-1 4-4 6 1M8 14l2-5 4-3m-4 3 5 2 3-2M4 21h16" /></svg>
                <span>SLIDE</span>
              </button>
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
                  <span>PUSH UP <i>·</i> AUTO SPRINT</span>
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

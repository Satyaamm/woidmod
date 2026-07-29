'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from 'react';
import { useTheme } from 'antd-style';
import type { GlobalToken } from 'antd';

/**
 * The one canvas primitive in the product.
 *
 * Everything time-aligned in the trace viewer — waveforms, lanes, the minimap —
 * is a `TraceCanvas` with a different painter. It owns the parts that are easy to
 * get subtly wrong and expensive to debug per-lane:
 *
 *   - devicePixelRatio scaling, so lines are crisp on retina rather than fuzzy
 *   - ResizeObserver-driven width, so lanes reflow with the layout
 *   - redraw coalesced into one rAF, so a pan that changes six lanes paints once
 *   - the antd theme token passed INTO the painter, so a lane can never hardcode
 *     a colour and can never be unreadable in the other theme
 *
 * Painters are pure `(ctx, size, token) => void`. They must not read React state.
 */

export interface CanvasSize {
  width: number;
  height: number;
}

export type CanvasPainter = (ctx: CanvasRenderingContext2D, size: CanvasSize, token: GlobalToken) => void;

export interface TraceCanvasProps {
  height: number;
  paint: CanvasPainter;
  /** Extra redraw trigger for painters that close over mutable data. */
  redrawKey?: string | number;
  className?: string;
  style?: CSSProperties;
  cursor?: CSSProperties['cursor'];
  ariaLabel?: string;
  onPointerDown?: (ms: PointerInfo) => void;
  onPointerMove?: (ms: PointerInfo) => void;
  onPointerLeave?: () => void;
  onWheel?: (e: ReactWheelEvent<HTMLCanvasElement>, size: CanvasSize) => void;
  /** Rendered on top of the canvas, positioned relative to it. */
  overlay?: ReactNode;
}

export interface PointerInfo {
  /** Pointer x/y in CSS pixels, relative to the canvas. */
  x: number;
  y: number;
  width: number;
  height: number;
  shiftKey: boolean;
  buttons: number;
}

export function TraceCanvas({
  height,
  paint,
  redrawKey,
  className,
  style,
  cursor = 'crosshair',
  ariaLabel,
  onPointerDown,
  onPointerMove,
  onPointerLeave,
  onWheel,
  overlay,
}: TraceCanvasProps) {
  const token = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const draw = useCallback(() => {
    frameRef.current = null;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || width <= 0) return;

    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    paint(ctx, { width, height }, token as GlobalToken);
  }, [paint, width, height, token]);

  useEffect(() => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(draw);
    return () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [draw, redrawKey]);

  const info = (e: ReactPointerEvent<HTMLCanvasElement>): PointerInfo => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      shiftKey: e.shiftKey,
      buttons: e.buttons,
    };
  };

  return (
    <div ref={hostRef} className={className} style={{ position: 'relative', width: '100%', ...style }}>
      <canvas
        ref={canvasRef}
        aria-label={ariaLabel}
        role="img"
        style={{ display: 'block', width: '100%', height, cursor, touchAction: 'none' }}
        onPointerDown={onPointerDown ? (e) => onPointerDown(info(e)) : undefined}
        onPointerMove={onPointerMove ? (e) => onPointerMove(info(e)) : undefined}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel ? (e) => onWheel(e, { width, height }) : undefined}
      />
      {overlay}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Canvas helpers shared by every painter
// ---------------------------------------------------------------------------

/** Maps a time window to pixels. Created per paint; cheap and allocation-free enough. */
export interface TimeScale {
  start: number;
  end: number;
  width: number;
  toX: (ms: number) => number;
  toMs: (x: number) => number;
  msPerPx: number;
}

export function createTimeScale(start: number, end: number, width: number): TimeScale {
  const span = Math.max(1, end - start);
  return {
    start,
    end,
    width,
    msPerPx: span / Math.max(1, width),
    toX: (ms) => ((ms - start) / span) * width,
    toMs: (x) => start + (x / Math.max(1, width)) * span,
  };
}

export function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** Crisp 1px vertical rule — canvas needs the half-pixel or it renders 2px grey. */
export function verticalRule(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number): void {
  const px = Math.round(x) + 0.5;
  ctx.beginPath();
  ctx.moveTo(px, y0);
  ctx.lineTo(px, y1);
  ctx.stroke();
}

/** Diagonal hatch, used for "generated but never heard" audio. */
export function hatchRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  gap = 5,
): void {
  if (w <= 0 || h <= 0) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.75;
  for (let i = -h; i < w; i += gap) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

/** Truncating text draw — labels inside spans must never spill into the next lane. */
export function clippedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
): void {
  if (maxWidth < 12) return;
  let out = text;
  if (ctx.measureText(out).width > maxWidth) {
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
    out = `${out}…`;
  }
  ctx.fillText(out, x, y);
}

/** `#rrggbb` + alpha, without pulling in a colour library. */
export function alpha(color: string, a: number): string {
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const hex =
      color.length === 4
        ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  if (color.startsWith('rgba(')) return color.replace(/[\d.]+\)$/, `${a})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${a})`);
  return color;
}

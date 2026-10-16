import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface RateLimitOptions {
  /** Max requests per client address per window. */
  perIpMax: () => number;
  /** Max requests from everyone combined per window. Behind tunnels all clients can share one
   * address, so this is the limit that actually protects upstream quota. */
  globalMax: () => number;
  windowMs: number;
}

/** Read a positive integer from the environment, else the fallback. */
export function envInt(name: string, fallback: number): () => number {
  return () => {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
}

/**
 * Builds a fixed-window, in-memory rate-limit guard. One class per route group so each has its own
 * counters. State is per process and resets on restart (fine for one backend instance).
 * Never logs addresses or bodies.
 */
export function createRateLimitGuard(options: RateLimitOptions) {
  @Injectable()
  class RateLimitGuard implements CanActivate {
    windowStart = 0;
    global = 0;
    readonly perIp = new Map<string, number>();

    canActivate(context: ExecutionContext): boolean {
      const now = Date.now();
      if (now - this.windowStart >= options.windowMs) {
        this.windowStart = now;
        this.global = 0;
        this.perIp.clear();
      }
      const http = context.switchToHttp();
      const key = http.getRequest<Request>().ip ?? 'unknown';
      const ipCount = (this.perIp.get(key) ?? 0) + 1;
      const globalCount = this.global + 1;
      if (ipCount > options.perIpMax() || globalCount > options.globalMax()) {
        const retryAfterSeconds = Math.max(1, Math.ceil((this.windowStart + options.windowMs - now) / 1000));
        http.getResponse<Response>().setHeader('Retry-After', String(retryAfterSeconds));
        throw new HttpException(
          { status: 'rate_limited', retryAfterSeconds },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.perIp.set(key, ipCount);
      this.global = globalCount;
      return true;
    }
  }
  return RateLimitGuard;
}

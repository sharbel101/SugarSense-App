import { timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';

/** Header the client sends with the shared app token. */
export const APP_TOKEN_HEADER = 'x-app-token';

/**
 * Shared-secret gate. Active only when APP_API_TOKEN is set; unset = open (prototype default, so a
 * deploy of this code alone changes nothing). The token is read per request so tests/ops can flip it.
 *
 * Limits, stated plainly: a token bundled into the public web build is visible to anyone who opens the
 * site, so it only keeps out casual scanners and bots. It is NOT user authentication.
 */
@Injectable()
export class AppTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.APP_API_TOKEN?.trim();
    if (!expected) return true;
    const header = context.switchToHttp().getRequest<Request>().headers[APP_TOKEN_HEADER];
    const supplied = typeof header === 'string' ? header : '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
    throw new UnauthorizedException({ status: 'unauthorized', reason: 'missing_or_invalid_app_token' });
  }
}

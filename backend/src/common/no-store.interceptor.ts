import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/**
 * Health data must never be kept by a browser, proxy or CDN cache: every response of the routes that carry it
 * says so. (GET /glucose already does the same with @Header.)
 */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    context.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}

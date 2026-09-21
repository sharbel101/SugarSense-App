import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';

describe('AppModule', () => {
  it('compiles and provides ConfigService', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef.get(ConfigService)).toBeDefined();
  });

  it('has the Postgres and Supabase client libraries installed', async () => {
    const pg = await import('pg');
    const supabase = await import('@supabase/supabase-js');
    expect(pg.default.Pool).toBeTypeOf('function');
    expect(supabase.createClient).toBeTypeOf('function');
  });
});

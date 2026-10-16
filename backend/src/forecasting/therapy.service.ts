import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import type { TherapySettingsInput } from './therapy.schema.js';
import { localMinuteOfDay, toIso, toSec } from './time.js';

interface Segment {
  startMinute: number;
  value: number;
}

export interface TherapyProfile {
  profileId: number;
  version: number;
  effectiveFromSec: number;
  source: 'clinician_prescribed' | 'user_entered' | 'import';
  insulinType: 'rapid' | 'ultra_rapid' | null;
  insulinPeakMin: number | null;
  insulinDurationMin: number | null;
  note: string | null;
  createdAtSec: number;
  icr: Segment[];
  isf: Segment[];
}

export interface ResolvedTherapy {
  profileId: number | null;
  version: number | null;
  icrStatus: 'available' | 'unavailable';
  icrGPerU: number | null;
  isfMgdlPerU: number | null;
  insulinType: 'rapid' | 'ultra_rapid' | null;
  insulinPeakMin: number | null;
  insulinDurationMin: number | null;
}

const segmentValueAt = (segments: Segment[], minuteOfDay: number): number | null => {
  let value: number | null = null;
  for (const s of segments) {
    if (s.startMinute <= minuteOfDay) value = s.value;
    else break;
  }
  return value;
};

/**
 * Resolves the setting that applied at a given instant: the newest version whose effective date is not
 * after that instant, then the segment covering the local time of day. A missing value stays null -
 * there is no default ratio anywhere in this class.
 */
export class TherapyResolver {
  constructor(
    private readonly profiles: readonly TherapyProfile[],
    private readonly timezone: string,
  ) {}

  at(tSec: number): ResolvedTherapy {
    let chosen: TherapyProfile | null = null;
    for (const p of this.profiles) {
      if (p.effectiveFromSec > tSec) continue;
      if (
        chosen === null ||
        p.effectiveFromSec > chosen.effectiveFromSec ||
        (p.effectiveFromSec === chosen.effectiveFromSec && p.version > chosen.version)
      ) {
        chosen = p;
      }
    }
    if (chosen === null) {
      return {
        profileId: null,
        version: null,
        icrStatus: 'unavailable',
        icrGPerU: null,
        isfMgdlPerU: null,
        insulinType: null,
        insulinPeakMin: null,
        insulinDurationMin: null,
      };
    }
    const minute = localMinuteOfDay(tSec, this.timezone);
    const icr = segmentValueAt(chosen.icr, minute);
    return {
      profileId: chosen.profileId,
      version: chosen.version,
      icrStatus: icr === null ? 'unavailable' : 'available',
      icrGPerU: icr,
      isfMgdlPerU: segmentValueAt(chosen.isf, minute),
      insulinType: chosen.insulinType,
      insulinPeakMin: chosen.insulinPeakMin,
      insulinDurationMin: chosen.insulinDurationMin,
    };
  }
}

const hhmm = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** What the settings screen sees. Field names carry the unit. */
export interface TherapySettingsView {
  status: 'set' | 'not_set';
  version: number | null;
  effectiveFrom: string | null;
  source: TherapyProfile['source'] | null;
  icrSegments: { startMinute: number; startTime: string; gramsPerUnit: number }[];
  isfSegments: { startMinute: number; startTime: string; mgdlPerUnit: number }[];
  insulinType: 'rapid' | 'ultra_rapid' | null;
  insulinPeakMin: number | null;
  insulinDurationMin: number | null;
  note: string | null;
  /** Fixed explanation of what happens while the ratio is missing - there is no default ratio. */
  whenMissing: string;
  disclaimer: string;
}

export const WHEN_ICR_MISSING =
  'Without an insulin-to-carbohydrate ratio and a correction factor, logged meals are not added to the forecast; ' +
  'the glucose-only forecast is shown instead. No default ratio is assumed.';
export const SETTINGS_DISCLAIMER =
  'These are the values you or your care team entered. SugarSense never changes them automatically and ' +
  'does not recommend insulin doses.';

@Injectable()
export class TherapyService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  async loadProfiles(userId: string): Promise<TherapyProfile[]> {
    const p = await this.db.query<{
      profile_id: string;
      version: number;
      effective_from: Date;
      source: TherapyProfile['source'];
      insulin_type: 'rapid' | 'ultra_rapid' | null;
      insulin_peak_min: string | null;
      insulin_duration_min: string | null;
      note: string | null;
      created_at: Date;
    }>(
      `SELECT profile_id, version, effective_from, source, insulin_type, insulin_peak_min,
              insulin_duration_min, note, created_at
         FROM therapy_profiles WHERE user_id = $1 ORDER BY effective_from, version`,
      [userId],
    );
    if (p.rows.length === 0) return [];
    const s = await this.db.query<{ profile_id: string; kind: 'icr' | 'isf'; start_minute: number; value: string }>(
      `SELECT profile_id, kind, start_minute, value FROM therapy_segments
        WHERE profile_id = ANY($1::bigint[]) ORDER BY profile_id, kind, start_minute`,
      [p.rows.map((r) => r.profile_id)],
    );
    return p.rows.map((r) => ({
      profileId: Number(r.profile_id),
      version: r.version,
      effectiveFromSec: Math.floor(r.effective_from.getTime() / 1000),
      source: r.source,
      insulinType: r.insulin_type,
      insulinPeakMin: r.insulin_peak_min === null ? null : Number(r.insulin_peak_min),
      insulinDurationMin: r.insulin_duration_min === null ? null : Number(r.insulin_duration_min),
      note: r.note,
      createdAtSec: Math.floor(r.created_at.getTime() / 1000),
      icr: s.rows.filter((x) => x.profile_id === r.profile_id && x.kind === 'icr').map((x) => ({ startMinute: x.start_minute, value: Number(x.value) })),
      isf: s.rows.filter((x) => x.profile_id === r.profile_id && x.kind === 'isf').map((x) => ({ startMinute: x.start_minute, value: Number(x.value) })),
    }));
  }

  async resolver(userId: string, timezone: string): Promise<TherapyResolver> {
    return new TherapyResolver(await this.loadProfiles(userId), timezone);
  }

  async getView(userId: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<TherapySettingsView> {
    const profiles = await this.loadProfiles(userId);
    const current = [...profiles]
      .filter((p) => p.effectiveFromSec <= nowSec)
      .sort((a, b) => a.effectiveFromSec - b.effectiveFromSec || a.version - b.version)
      .pop();
    return this.toView(current ?? null);
  }

  async history(userId: string): Promise<TherapySettingsView[]> {
    const profiles = await this.loadProfiles(userId);
    return profiles.sort((a, b) => b.version - a.version).map((p) => this.toView(p));
  }

  /**
   * Creates a new version. Unsent parts carry over from the newest version, so a screen that only edits
   * the ICR cannot accidentally erase the correction factor. Never updates or deletes an old version.
   */
  async setSettings(userId: string, input: TherapySettingsInput, nowSec: number = Math.floor(Date.now() / 1000)): Promise<TherapySettingsView> {
    const effectiveFromSec = input.effectiveFrom ? toSec(input.effectiveFrom) : nowSec;
    if (effectiveFromSec > nowSec + 24 * 3600) {
      throw new BadRequestException('effectiveFrom must not be more than 24 hours in the future');
    }
    const created = await this.db.tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(727003)');
      const latest = await c.query<{ profile_id: string; version: number; insulin_type: string | null; insulin_peak_min: string | null; insulin_duration_min: string | null }>(
        'SELECT profile_id, version, insulin_type, insulin_peak_min, insulin_duration_min FROM therapy_profiles WHERE user_id = $1 ORDER BY version DESC LIMIT 1',
        [userId],
      );
      const prev = latest.rows[0];
      let isfSegments: { startMinute: number; value: number }[] | null = input.isfSegments?.map((s) => ({ startMinute: s.startMinute, value: s.mgdlPerUnit })) ?? null;
      if (isfSegments === null && prev) {
        const old = await c.query<{ start_minute: number; value: string }>(
          "SELECT start_minute, value FROM therapy_segments WHERE profile_id = $1 AND kind = 'isf' ORDER BY start_minute",
          [prev.profile_id],
        );
        isfSegments = old.rows.map((r) => ({ startMinute: r.start_minute, value: Number(r.value) }));
      }
      const insulinType = input.insulinType ?? (prev?.insulin_type as 'rapid' | 'ultra_rapid' | null | undefined) ?? null;
      const peak = input.insulinPeakMin ?? (prev?.insulin_peak_min != null ? Number(prev.insulin_peak_min) : null);
      const duration = input.insulinDurationMin ?? (prev?.insulin_duration_min != null ? Number(prev.insulin_duration_min) : null);
      if (peak !== null && duration !== null && !(peak < duration / 2)) {
        throw new BadRequestException('insulinPeakMin must be less than half of insulinDurationMin');
      }
      const version = (prev?.version ?? 0) + 1;
      const row = await c.query<{ profile_id: string }>(
        `INSERT INTO therapy_profiles (user_id, version, effective_from, source, insulin_type, insulin_peak_min, insulin_duration_min, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING profile_id`,
        [userId, version, toIso(effectiveFromSec), input.source, insulinType, peak, duration, input.note ?? null],
      );
      const profileId = row.rows[0]?.profile_id as string;
      for (const s of input.icrSegments) {
        await c.query(
          "INSERT INTO therapy_segments (profile_id, kind, start_minute, value) VALUES ($1, 'icr', $2, $3)",
          [profileId, s.startMinute, s.gramsPerUnit],
        );
      }
      for (const s of isfSegments ?? []) {
        await c.query(
          "INSERT INTO therapy_segments (profile_id, kind, start_minute, value) VALUES ($1, 'isf', $2, $3)",
          [profileId, s.startMinute, s.value],
        );
      }
      return Number(profileId);
    });
    const profiles = await this.loadProfiles(userId);
    return this.toView(profiles.find((p) => p.profileId === created) ?? null);
  }

  private toView(p: TherapyProfile | null): TherapySettingsView {
    return {
      status: p ? 'set' : 'not_set',
      version: p?.version ?? null,
      effectiveFrom: p ? toIso(p.effectiveFromSec) : null,
      source: p?.source ?? null,
      icrSegments: (p?.icr ?? []).map((s) => ({ startMinute: s.startMinute, startTime: hhmm(s.startMinute), gramsPerUnit: s.value })),
      isfSegments: (p?.isf ?? []).map((s) => ({ startMinute: s.startMinute, startTime: hhmm(s.startMinute), mgdlPerUnit: s.value })),
      insulinType: p?.insulinType ?? null,
      insulinPeakMin: p?.insulinPeakMin ?? null,
      insulinDurationMin: p?.insulinDurationMin ?? null,
      note: p?.note ?? null,
      whenMissing: WHEN_ICR_MISSING,
      disclaimer: SETTINGS_DISCLAIMER,
    };
  }
}

import { Module } from '@nestjs/common';
import { BaselineErrorService } from './baseline-error.service.js';
import { EventsService } from './events.service.js';
import { GlucoseIngestService } from './glucose-ingest.service.js';
import { OutcomeService } from './outcome.service.js';
import { ParametersService } from './parameters.service.js';
import { PersonalizationService } from './personalization.service.js';
import { PredictionStore } from './prediction-store.service.js';
import { TherapyService } from './therapy.service.js';
import { UsersService } from './users.service.js';

const SERVICES = [
  UsersService,
  TherapyService,
  EventsService,
  ParametersService,
  BaselineErrorService,
  PredictionStore,
  OutcomeService,
  PersonalizationService,
  GlucoseIngestService,
];

/** Database-backed services with no dependency on the glucose proxy (so the proxy can depend on them). */
@Module({ providers: SERVICES, exports: SERVICES })
export class PersistenceModule {}

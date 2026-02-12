import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';

@Entity({ name: 'meter_telemetry_history' })
@Index('idx_meter_history_device_time', ['meterId', 'recordedAt'])
export class MeterTelemetryHistory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'meter_id', type: 'varchar', length: 64 })
  meterId: string;

  @Column({ name: 'kwh_consumed_ac', type: 'numeric', precision: 10, scale: 4 })
  kwhConsumedAc: number;

  @Column({ name: 'voltage', type: 'numeric', precision: 6, scale: 2 })
  voltage: number;

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;

  @Column({
    name: 'ingested_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  ingestedAt: Date;
}

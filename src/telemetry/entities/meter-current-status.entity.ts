import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity({ name: 'meter_current_status' })
export class MeterCurrentStatus {
  @PrimaryColumn({ name: 'meter_id', type: 'varchar', length: 64 })
  meterId: string;

  @Column({ name: 'kwh_consumed_ac', type: 'numeric', precision: 10, scale: 4 })
  kwhConsumedAc: number;

  @Column({ name: 'voltage', type: 'numeric', precision: 6, scale: 2 })
  voltage: number;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  updatedAt: Date;
}

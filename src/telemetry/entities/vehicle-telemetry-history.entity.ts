import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  Index,
} from 'typeorm';

@Entity({ name: 'vehicle_telemetry_history' })
@Index('idx_vehicle_history_device_time', ['vehicleId', 'recordedAt'])
export class VehicleTelemetryHistory {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string; // bigint comes back as string from pg driver

  @Column({ name: 'vehicle_id', type: 'varchar', length: 64 })
  vehicleId: string;

  @Column({ name: 'soc', type: 'numeric', precision: 5, scale: 2 })
  soc: number;

  @Column({ name: 'kwh_delivered_dc', type: 'numeric', precision: 10, scale: 4 })
  kwhDeliveredDc: number;

  @Column({ name: 'battery_temp', type: 'numeric', precision: 5, scale: 2 })
  batteryTemp: number;

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;

  @Column({
    name: 'ingested_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  ingestedAt: Date;
}

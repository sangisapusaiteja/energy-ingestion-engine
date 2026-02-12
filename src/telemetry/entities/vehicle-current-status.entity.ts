import { Entity, Column, PrimaryColumn } from 'typeorm';

@Entity({ name: 'vehicle_current_status' })
export class VehicleCurrentStatus {
  @PrimaryColumn({ name: 'vehicle_id', type: 'varchar', length: 64 })
  vehicleId: string;

  @Column({ name: 'soc', type: 'numeric', precision: 5, scale: 2 })
  soc: number;

  @Column({ name: 'kwh_delivered_dc', type: 'numeric', precision: 10, scale: 4 })
  kwhDeliveredDc: number;

  @Column({ name: 'battery_temp', type: 'numeric', precision: 5, scale: 2 })
  batteryTemp: number;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({
    name: 'updated_at',
    type: 'timestamptz',
    default: () => 'NOW()',
  })
  updatedAt: Date;
}

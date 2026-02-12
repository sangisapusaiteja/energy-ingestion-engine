import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export function getDatabaseConfig(): TypeOrmModuleOptions {
  const isProd = process.env.NODE_ENV === 'production';

  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'energy_engine',

    // Entity auto-discovery
    autoLoadEntities: true,

    // NEVER true in production — use the schema.sql migration
    synchronize: false,

    // Connection pool tuned for PgBouncer + write-heavy ingestion
    extra: {
      // ── Pool sizing ───────────────────────────────────────────────
      // App-side pool per replica. With 3 replicas × 20 = 60 client
      // connections to PgBouncer. PgBouncer's default_pool_size (40)
      // multiplexes these into 40 actual Postgres connections.
      max: isProd ? 20 : 10,
      min: isProd ? 5 : 2,

      // Idle connection timeout
      idleTimeoutMillis: 30000,

      // Connection timeout — fail fast if PgBouncer is overloaded
      connectionTimeoutMillis: 5000,

      // Statement timeout — kill queries running longer than 30s
      statement_timeout: 30000,

      // ── PgBouncer compatibility ───────────────────────────────────
      // PgBouncer in transaction mode does NOT support prepared
      // statements across transactions (the prepared statement lives
      // on a server connection that may be reassigned).
      // Setting this to false disables pg driver's implicit prepare.
      // TypeORM's parameterized queries still work — they use
      // extended query protocol with unnamed statements.
      ...(isProd && {
        // Disable named prepared statements for PgBouncer compatibility.
        // Extended query protocol with unnamed statements still works.
        prepareThreshold: 0,
      }),
    },

    logging: isProd ? ['error'] : ['error', 'warn'],
  };
}

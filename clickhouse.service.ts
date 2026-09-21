import {Injectable, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {ClickHouseClient, createClient} from '@clickhouse/client';
import {
  ClickhouseTableConfig,
  ClickhouseQueryObject,
  ClickhouseDeleteObject,
  ClickhouseColumnMeta,
  ClickhouseSchemaDiff,
} from './clickhouse.types';

/**
 * Shared ClickHouse service.
 *
 * Two layers of responsibility:
 * 1. Connection management (query/insert/ping/close) — thin pass-through to @clickhouse/client.
 * 2. Schema-driven helpers (createDatabase/createModel + ClickhouseModel):
 *    - schema-based CREATE TABLE IF NOT EXISTS (autoCreate)
 *    - schema-diff ALTER TABLE ADD/DROP/MODIFY COLUMN (autoSync)
 *    - model.find() query builder (with subquery chaining)
 *    - model.delete() (ALTER TABLE ... DELETE WHERE ...)
 */
@Injectable()
export class ClickhouseService implements OnModuleInit, OnModuleDestroy {
  private readonly client: ClickHouseClient;
  // Cached default database from microservices.clickhouse.database — used as a
  // fallback when createModel callers don't explicitly pass a database name.
  private readonly defaultDbName?: string;

  constructor(private readonly configService: ConfigService) {
    // Read the shared ClickHouse configuration through NestJS configuration services.
    const url = this.configService.getOrThrow<string>('microservices.clickhouse.url') || 'http://localhost:8123';
    const username = this.configService.get<string>('microservices.clickhouse.username') || 'default';
    const password = this.configService.get<string>('microservices.clickhouse.password') || '';
    const database = this.configService.get<string | undefined>('microservices.clickhouse.database');

    this.defaultDbName = database;
    this.client = createClient({
      url,
      username,
      password,
      database,
    });
  }

  async query(options: Parameters<ClickHouseClient['query']>[0]) {
    return this.client.query(options);
  }

  async insert(options: Parameters<ClickHouseClient['insert']>[0]) {
    return this.client.insert(options);
  }

  async onModuleInit(): Promise<void> {
    // Verify connectivity on startup by running a lightweight ping query.
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
  }

  // ---------------------------------------------------------------------------
  // Schema-driven helpers
  // ---------------------------------------------------------------------------

  // Create database if not exists.
  async createDatabase(dbName: string): Promise<void> {
    await this.query({query: `CREATE DATABASE IF NOT EXISTS ${dbName}`});
  }

  // Create a model instance:
  //   - If the table does not exist and autoCreate !== false → CREATE TABLE IF NOT EXISTS.
  //   - If the table exists and autoSync is true → diff the code schema against the actual
  //     table columns and issue ALTER TABLE ADD/DROP/MODIFY COLUMN to reconcile.
  // autoCreate must be truthy for autoSync to run.
  // dbName is optional; when omitted, falls back to the connection's default database
  // (microservices.clickhouse.database). If both are unset, the bare table name is
  // used and ClickHouse resolves it against the user's default database.
  async createModel<T = any>(config: ClickhouseTableConfig, dbName?: string): Promise<ClickhouseModel<T>> {
    const resolvedDbName = dbName ?? this.defaultDbName;
    const table = resolvedDbName ? `${resolvedDbName}.${config.tableName}` : config.tableName;
    if (config.autoCreate !== false) {
      const tableMeta = await this.getTableMeta(table);
      if (tableMeta) {
        if (config.autoSync) {
          const diff = this.diffTableMeta(config.schema, tableMeta);
          if (diff.addColumns.length || diff.deleteColumns.length || diff.modifyColumns.length) {
            await this.syncTable(table, diff);
          }
        }
      } else {
        await this.createTable(table, config);
      }
    }
    return new ClickhouseModel<T>(this, table, config);
  }

  // Fetch the column metadata of an existing table via DESCRIBE TABLE.
  // Returns null when the table does not exist.
  private async getTableMeta(table: string): Promise<ClickhouseColumnMeta[] | null> {
    try {
      const result = await this.query({query: `DESCRIBE TABLE ${table}`, format: 'JSONEachRow'});
      return (await result.json()) as ClickhouseColumnMeta[];
    } catch (err: any) {
      const msg = String(err?.message || err);
      // ClickHouse error code 60 / "doesn't exist" / "does not exist" → table missing.
      if (msg.includes('does not exist') || msg.includes("doesn't exist") || err?.code === 60) {
        return null;
      }
      throw err; // Re-throw unexpected errors (network, auth, etc.).
    }
  }

  // Compare the code schema against the actual table columns.
  // Returns columns to add (in code only), delete (in table only), and modify (type changed).
  private diffTableMeta(
    codeSchema: ClickhouseTableConfig['schema'],
    tableMeta: ClickhouseColumnMeta[]
  ): ClickhouseSchemaDiff {
    const tableMetaMap = new Map(tableMeta.map(c => [c.name, c.type]));
    const addColumns: ClickhouseSchemaDiff['addColumns'] = [];
    const modifyColumns: ClickhouseSchemaDiff['modifyColumns'] = [];
    for (const [name, def] of Object.entries(codeSchema)) {
      const actualType = tableMetaMap.get(name);
      if (actualType !== undefined) {
        if (normalizeType(def.type) !== normalizeType(actualType)) {
          modifyColumns.push({name, type: def.type});
        }
        tableMetaMap.delete(name);
      } else {
        addColumns.push({name, type: def.type});
      }
    }
    const deleteColumns = Array.from(tableMetaMap.keys());
    return {addColumns, deleteColumns, modifyColumns};
  }

  // Apply the schema diff to the table via ALTER TABLE ADD/DROP/MODIFY COLUMN.
  private async syncTable(table: string, diff: ClickhouseSchemaDiff): Promise<void> {
    const statements: string[] = [];
    for (const name of diff.deleteColumns) {
      statements.push(`ALTER TABLE ${table} DROP COLUMN ${name}`);
    }
    for (const item of diff.addColumns) {
      statements.push(`ALTER TABLE ${table} ADD COLUMN ${item.name} ${item.type}`);
    }
    for (const item of diff.modifyColumns) {
      statements.push(`ALTER TABLE ${table} MODIFY COLUMN ${item.name} ${item.type}`);
    }
    for (const sql of statements) {
      await this.query({query: sql});
    }
  }

  // Generate and execute CREATE TABLE IF NOT EXISTS from schema config.
  // Function defaults (e.g. Date.now) are for data insertion, not DDL — skipped here.
  private async createTable(table: string, config: ClickhouseTableConfig): Promise<void> {
    const columns = Object.entries(config.schema)
      .map(([name, def]) => {
        const parts = [name, def.type];
        if (def.default !== undefined && typeof def.default !== 'function') {
          parts.push(`DEFAULT ${def.default}`);
        }
        return parts.join(' ');
      })
      .join(', ');
    const ddl = `CREATE TABLE IF NOT EXISTS ${table} (${columns}) ${config.options}`;
    await this.query({query: ddl});
  }
}

// Trim whitespace and lowercase for type comparison so "LowCardinality( String )"
// and "LowCardinality(String)" are treated as the same type.
function normalizeType(type: string): string {
  return type.replace(/\s+/g, '').toLowerCase();
}

/**
 * Model bound to a single ClickHouse table. Provides a query builder for find()
 * and an ALTER TABLE DELETE helper for delete().
 */
export class ClickhouseModel<T = any> {
  constructor(
    private readonly ch: ClickhouseService,
    private readonly table: string,
    private readonly config: ClickhouseTableConfig
  ) {}

  // Query builder: single object or chained array (subquery wrapping).
  async find(qObjArray: ClickhouseQueryObject | ClickhouseQueryObject[]): Promise<T[]> {
    if (!Array.isArray(qObjArray)) qObjArray = [qObjArray];
    let sql = '';
    qObjArray.forEach((qObj, i) => {
      const target = i === 0 ? this.table : `(${sql})`;
      sql = this.objectToSql(target, qObj);
    });
    const result = await this.ch.query({query: sql, format: 'JSONEachRow'});
    return (await result.json()) as T[];
  }

  // ALTER TABLE ... DELETE WHERE ...
  async delete(delObj: ClickhouseDeleteObject): Promise<void> {
    const sql = `ALTER TABLE ${this.table} DELETE WHERE ${delObj.where}`;
    await this.ch.query({query: sql});
  }

  // INSERT INTO ... VALUES (for SDK ingestion endpoints if needed).
  async insertMany(rows: T[]): Promise<void> {
    if (!rows.length) return;
    const columns = Object.keys(this.config.schema);
    await this.ch.insert({
      table: this.table,
      values: rows.map(r => columns.reduce((obj, col) => ({...obj, [col]: (r as any)[col] ?? null}), {})),
      format: 'JSONEachRow',
    });
  }

  // Build SELECT SQL from a query object.
  private objectToSql(table: string, q: ClickhouseQueryObject): string {
    const where = q.where ? ` WHERE ${q.where}` : '';
    const groupBy = q.groupBy ? ` GROUP BY ${q.groupBy}` : '';
    const orderBy = q.orderBy ? ` ORDER BY ${q.orderBy}` : '';
    const limit = q.limit ? ` LIMIT ${q.skip ? `${q.skip},` : ''}${q.limit}` : '';
    return `SELECT ${q.select || '*'} FROM ${table}${where}${groupBy}${orderBy}${limit}`;
  }
}

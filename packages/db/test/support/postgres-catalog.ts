import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface PostgresCatalog {
  readonly constraints: readonly CatalogConstraint[];
  readonly enums: readonly CatalogEnum[];
  readonly functions: readonly CatalogFunction[];
  readonly indexes: readonly CatalogIndex[];
  readonly tables: readonly CatalogTable[];
  readonly triggers: readonly CatalogTrigger[];
}

interface CatalogTable {
  readonly columns: readonly CatalogColumn[];
  readonly name: string;
}

interface CatalogColumn {
  readonly collation: string | null;
  readonly default: string | null;
  readonly generated: string;
  readonly identity: string;
  readonly name: string;
  readonly nullable: boolean;
  readonly position: number;
  readonly type: string;
}

interface CatalogEnum {
  readonly labels: readonly string[];
  readonly name: string;
}

interface CatalogIndex {
  readonly clustered: boolean;
  readonly columns: readonly CatalogIndexColumn[];
  readonly method: string;
  readonly name: string;
  readonly predicate: string | null;
  readonly primary: boolean;
  readonly ready: boolean;
  readonly replicaIdentity: boolean;
  readonly table: string;
  readonly unique: boolean;
  readonly valid: boolean;
}

interface CatalogIndexColumn {
  readonly definition: string;
  readonly key: boolean;
  readonly position: number;
}

type MutableCatalogIndex = Omit<CatalogIndex, "columns"> & {
  readonly columns: CatalogIndexColumn[];
};

interface CatalogConstraint {
  readonly deferred: boolean;
  readonly deferrable: boolean;
  readonly definition: string;
  readonly name: string;
  readonly table: string;
  readonly type: string;
  readonly validated: boolean;
}

interface CatalogTrigger {
  readonly definition: string;
  readonly enabled: string;
  readonly name: string;
  readonly table: string;
}

interface CatalogFunction {
  readonly definition: string;
  readonly identityArguments: string;
  readonly language: string;
  readonly leakproof: boolean;
  readonly name: string;
  readonly parallel: string;
  readonly result: string;
  readonly securityDefiner: boolean;
  readonly strict: boolean;
  readonly volatility: string;
}

export interface ExpectedPostgresCatalog {
  readonly catalog: PostgresCatalog;
  readonly catalogHash: string;
  readonly formatVersion: 1;
}

export async function readPostgresCatalog(pool: Pick<Pool, "query">): Promise<PostgresCatalog> {
  const [columns, enums, indexes, constraints, triggers, functions] = await Promise.all([
    pool.query<{
      collation: string | null;
      default: string | null;
      generated: string;
      identity: string;
      name: string;
      nullable: boolean;
      position: number;
      table: string;
      type: string;
    }>(`
      select relation.relname as "table",
             attribute.attnum as position,
             attribute.attname as name,
             pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as type,
             not attribute.attnotnull as nullable,
             pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) as "default",
             attribute.attidentity as identity,
             attribute.attgenerated as generated,
             case
               when attribute.attcollation = type_record.typcollation then null
               else collation_record.collname
             end as "collation"
        from pg_catalog.pg_attribute attribute
        join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        join pg_catalog.pg_type type_record on type_record.oid = attribute.atttypid
        left join pg_catalog.pg_attrdef default_value
          on default_value.adrelid = attribute.attrelid
         and default_value.adnum = attribute.attnum
        left join pg_catalog.pg_collation collation_record
          on collation_record.oid = attribute.attcollation
       where namespace.nspname = 'public'
         and relation.relkind in ('r', 'p')
         and attribute.attnum > 0
         and not attribute.attisdropped
       order by relation.relname, attribute.attnum
    `),
    pool.query<{ label: string; name: string; position: number }>(`
      select type_record.typname as name,
             enum_record.enumsortorder::float8 as position,
             enum_record.enumlabel as label
        from pg_catalog.pg_type type_record
        join pg_catalog.pg_namespace namespace on namespace.oid = type_record.typnamespace
        join pg_catalog.pg_enum enum_record on enum_record.enumtypid = type_record.oid
       where namespace.nspname = 'public'
       order by type_record.typname, enum_record.enumsortorder
    `),
    pool.query<{
      clustered: boolean;
      columnDefinition: string;
      columnPosition: number;
      key: boolean;
      method: string;
      name: string;
      predicate: string | null;
      primary: boolean;
      ready: boolean;
      replicaIdentity: boolean;
      table: string;
      unique: boolean;
      valid: boolean;
    }>(`
      select table_relation.relname as "table",
             index_relation.relname as name,
             index_record.indisunique as "unique",
             index_record.indisprimary as "primary",
             index_record.indisvalid as valid,
             index_record.indisready as ready,
             index_record.indisclustered as clustered,
             index_record.indisreplident as "replicaIdentity",
             access_method.amname as method,
             pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid, true) as predicate,
             column_position as "columnPosition",
             column_position <= index_record.indnkeyatts as key,
             pg_catalog.pg_get_indexdef(index_record.indexrelid, column_position, true)
               as "columnDefinition"
        from pg_catalog.pg_index index_record
        join pg_catalog.pg_class index_relation on index_relation.oid = index_record.indexrelid
        join pg_catalog.pg_class table_relation on table_relation.oid = index_record.indrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = table_relation.relnamespace
        join pg_catalog.pg_am access_method on access_method.oid = index_relation.relam
        cross join lateral generate_series(1, index_record.indnatts) as column_position
       where namespace.nspname = 'public'
       order by table_relation.relname, index_relation.relname, column_position
    `),
    pool.query<{
      deferred: boolean;
      deferrable: boolean;
      definition: string;
      name: string;
      table: string;
      type: string;
      validated: boolean;
    }>(`
      select relation.relname as "table",
             constraint_record.conname as name,
             constraint_record.contype as type,
             constraint_record.condeferrable as deferrable,
             constraint_record.condeferred as deferred,
             constraint_record.convalidated as validated,
             pg_catalog.pg_get_constraintdef(constraint_record.oid, true) as definition
        from pg_catalog.pg_constraint constraint_record
        join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'public'
       order by relation.relname, constraint_record.conname
    `),
    pool.query<{
      definition: string;
      enabled: string;
      name: string;
      table: string;
    }>(`
      select relation.relname as "table",
             trigger_record.tgname as name,
             trigger_record.tgenabled as enabled,
             pg_catalog.pg_get_triggerdef(trigger_record.oid, true) as definition
        from pg_catalog.pg_trigger trigger_record
        join pg_catalog.pg_class relation on relation.oid = trigger_record.tgrelid
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'public'
         and not trigger_record.tgisinternal
       order by relation.relname, trigger_record.tgname
    `),
    pool.query<{
      definition: string;
      identityArguments: string;
      language: string;
      leakproof: boolean;
      name: string;
      parallel: string;
      result: string;
      securityDefiner: boolean;
      strict: boolean;
      volatility: string;
    }>(`
      select procedure.proname as name,
             pg_catalog.pg_get_function_identity_arguments(procedure.oid) as "identityArguments",
             pg_catalog.pg_get_function_result(procedure.oid) as result,
             language.lanname as language,
             procedure.provolatile as volatility,
             procedure.proparallel as parallel,
             procedure.proisstrict as strict,
             procedure.prosecdef as "securityDefiner",
             procedure.proleakproof as leakproof,
             pg_catalog.pg_get_functiondef(procedure.oid) as definition
        from pg_catalog.pg_proc procedure
        join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
        join pg_catalog.pg_language language on language.oid = procedure.prolang
       where namespace.nspname = 'public'
         and procedure.prokind = 'f'
       order by procedure.proname, pg_catalog.pg_get_function_identity_arguments(procedure.oid)
    `),
  ]);

  const tables = new Map<string, CatalogColumn[]>();
  for (const row of columns.rows) {
    const tableColumns = tables.get(row.table) ?? [];
    tableColumns.push({
      position: row.position,
      name: row.name,
      type: normalizeCatalogText(row.type),
      nullable: row.nullable,
      default: normalizeNullableText(row.default),
      identity: row.identity,
      generated: row.generated,
      collation: row.collation,
    });
    tables.set(row.table, tableColumns);
  }

  const enumMap = new Map<string, string[]>();
  for (const row of enums.rows) {
    const labels = enumMap.get(row.name) ?? [];
    labels.push(row.label);
    enumMap.set(row.name, labels);
  }

  const indexMap = new Map<string, MutableCatalogIndex>();
  for (const row of indexes.rows) {
    const key = `${row.table}\u0000${row.name}`;
    const existing = indexMap.get(key);
    const column = {
      position: row.columnPosition,
      key: row.key,
      definition: normalizeCatalogText(row.columnDefinition),
    };
    if (existing === undefined) {
      indexMap.set(key, {
        table: row.table,
        name: row.name,
        unique: row.unique,
        primary: row.primary,
        valid: row.valid,
        ready: row.ready,
        clustered: row.clustered,
        replicaIdentity: row.replicaIdentity,
        method: row.method,
        predicate: normalizeNullableText(row.predicate),
        columns: [column],
      });
    } else {
      existing.columns.push(column);
    }
  }

  return {
    tables: Array.from(tables, ([name, tableColumns]) => ({ name, columns: tableColumns })),
    enums: Array.from(enumMap, ([name, labels]) => ({ name, labels })),
    indexes: Array.from(indexMap.values()),
    constraints: constraints.rows.map((row) => ({
      ...row,
      definition: normalizeCatalogText(row.definition),
    })),
    triggers: triggers.rows.map((row) => ({
      ...row,
      definition: normalizeCatalogText(row.definition),
    })),
    functions: functions.rows.map((row) => ({
      ...row,
      identityArguments: normalizeCatalogText(row.identityArguments),
      result: normalizeCatalogText(row.result),
      definition: normalizeCatalogText(row.definition),
    })),
  };
}

export function postgresCatalogHash(catalog: PostgresCatalog): string {
  return createHash("sha256").update(canonicalJson(catalog)).digest("hex");
}

function normalizeNullableText(value: string | null): string | null {
  return value === null ? null : normalizeCatalogText(value);
}

function normalizeCatalogText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll(/(?:"public"|public)\./g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

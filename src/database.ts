/**
 * ModuQL Database
 *
 * SQLite wrapper using sql.js for browser-based storage.
 * Provides a simple API for CRUD operations with automatic
 * operation logging for sync.
 *
 * Uses SQLite savepoints for rollback when authority order
 * differs from local optimistic order.
 */

import type { Operation, PendingOperation, TableSchema, QueryResult } from './types';

// sql.js types (loaded dynamically)
type SqlJsDatabase = any;
type SqlJs = any;

export class Database {
  private db: SqlJsDatabase | null = null;
  private sqlJs: SqlJs | null = null;
  private dbName: string;
  private localSeqCounter: number = 0;
  private clientId: string;

  /** Last confirmed sequence number from authority */
  private confirmedSeq: number = 0;

  /** Savepoint name for rollback */
  private savepointSeq: number = 0;

  /** Pending operations waiting for authority confirmation */
  public pendingOps: PendingOperation[] = [];

  /** Confirmed operations (for replay after rollback) */
  private confirmedOps: Operation[] = [];

  /** Callback when a new operation is created locally */
  public onOperation?: (op: PendingOperation) => void;

  constructor(dbName: string = 'sumql', clientId: string) {
    this.dbName = dbName;
    this.clientId = clientId;
  }

  /** Load a script from URL */
  private loadScript(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.head.appendChild(script);
    });
  }

  /** Initialize the database */
  async init(): Promise<void> {
    // Load sql.js from CDN (more reliable than bundling WASM)
    if (!(window as any).initSqlJs) {
      await this.loadScript('https://sql.js.org/dist/sql-wasm.js');
    }

    const initSqlJs = (window as any).initSqlJs;
    if (!initSqlJs) {
      throw new Error('Failed to load sql.js');
    }

    this.sqlJs = await initSqlJs({
      locateFile: (file: string) => `https://sql.js.org/dist/${file}`
    });

    // Try to load existing database from localStorage
    const saved = localStorage.getItem(`modusql_${this.dbName}`);
    if (saved) {
      const data = new Uint8Array(JSON.parse(saved));
      this.db = new this.sqlJs.Database(data);
    } else {
      this.db = new this.sqlJs.Database();
    }

    // Create internal tables for sync tracking
    this.db.run(`
      CREATE TABLE IF NOT EXISTS _modusql_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS _modusql_ops (
        id TEXT PRIMARY KEY,
        seq INTEGER,
        local_seq INTEGER,
        table_name TEXT,
        op_type TEXT,
        data TEXT,
        client_id TEXT,
        confirmed INTEGER DEFAULT 0
      )
    `);

    // Load local seq counter
    const result = this.db.exec(`SELECT value FROM _modusql_meta WHERE key = 'local_seq'`);
    if (result.length > 0 && result[0].values.length > 0) {
      this.localSeqCounter = parseInt(result[0].values[0][0] as string, 10);
    }
  }

  /** Save database to localStorage */
  private persist(): void {
    if (!this.db) return;
    const data = this.db.export();
    localStorage.setItem(`modusql_${this.dbName}`, JSON.stringify(Array.from(data)));
  }

  /** Create a table */
  createTable(schema: TableSchema): void {
    if (!this.db) throw new Error('Database not initialized');

    const columns = schema.columns.map(col => {
      let def = `${col.name} ${col.type}`;
      if (!col.nullable) def += ' NOT NULL';
      if (col.default !== undefined) def += ` DEFAULT ${JSON.stringify(col.default)}`;
      return def;
    });

    if (schema.primaryKey) {
      columns.push(`PRIMARY KEY (${schema.primaryKey})`);
    }

    this.db.run(`CREATE TABLE IF NOT EXISTS ${schema.name} (${columns.join(', ')})`);
    this.persist();
  }

  /** Insert a row */
  insert(table: string, data: Record<string, any>): PendingOperation {
    if (!this.db) throw new Error('Database not initialized');

    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = columns.map(() => '?').join(', ');

    this.db.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
      values
    );

    const op = this.createOperation(table, 'INSERT', data);
    this.persist();
    return op;
  }

  /** Update rows */
  update(table: string, data: Record<string, any>, where: Record<string, any>): PendingOperation {
    if (!this.db) throw new Error('Database not initialized');

    const setClauses = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const whereClauses = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
    const values = [...Object.values(data), ...Object.values(where)];

    this.db.run(
      `UPDATE ${table} SET ${setClauses} WHERE ${whereClauses}`,
      values
    );

    const op = this.createOperation(table, 'UPDATE', { ...data, _where: where });
    this.persist();
    return op;
  }

  /** Delete rows */
  delete(table: string, where: Record<string, any>): PendingOperation {
    if (!this.db) throw new Error('Database not initialized');

    const whereClauses = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
    const values = Object.values(where);

    this.db.run(`DELETE FROM ${table} WHERE ${whereClauses}`, values);

    const op = this.createOperation(table, 'DELETE', { _where: where });
    this.persist();
    return op;
  }

  /** Query rows */
  query<T = Record<string, any>>(sql: string, params: any[] = []): QueryResult<T> {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.exec(sql, params);

    if (result.length === 0) {
      return { rows: [], rowsAffected: 0 };
    }

    const columns = result[0].columns;
    const rows = result[0].values.map((row: any[]) => {
      const obj: Record<string, any> = {};
      columns.forEach((col: string, i: number) => {
        obj[col] = row[i];
      });
      return obj as T;
    });

    return { rows, rowsAffected: rows.length };
  }

  /** Apply a confirmed operation from the network */
  applyOperation(op: Operation): void {
    if (!this.db) throw new Error('Database not initialized');

    // Check if this is the next expected seq
    const expectedSeq = this.confirmedSeq + 1;

    // Check if we created this operation locally
    const pendingIndex = this.pendingOps.findIndex(p => p.id === op.id);
    const isPending = pendingIndex !== -1;

    if (op.seq === expectedSeq) {
      // Happy path: operation is in order
      if (isPending) {
        // Confirm our pending operation
        this.pendingOps.splice(pendingIndex, 1);
      } else {
        // Apply remote operation
        this.applyOp(op);
      }

      this.confirmedSeq = op.seq;
      this.confirmedOps.push(op);
      this.createSavepoint();
    } else if (op.seq > expectedSeq) {
      // Out of order: we're missing operations, buffer this one
      console.warn(`[ModuSQL] Received seq ${op.seq}, expected ${expectedSeq}. Buffering.`);
      // In a real implementation, we'd buffer and request missing ops
      // For now, just apply it
      if (!isPending) {
        this.applyOp(op);
      }
      this.confirmedSeq = op.seq;
      this.confirmedOps.push(op);
    } else if (op.seq <= this.confirmedSeq) {
      // Already processed this seq, skip
      return;
    }

    // Check if pending ops need reordering
    if (this.pendingOps.length > 0 && !isPending) {
      // A remote operation came in while we have pending ops
      // This means our optimistic state might be wrong
      this.rollbackAndReplay(op);
    }

    // Update operation record
    this.db.run(
      `INSERT OR REPLACE INTO _modusql_ops (id, seq, table_name, op_type, data, client_id, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [op.id, op.seq, op.table, op.type, JSON.stringify(op.data), op.clientId]
    );

    this.persist();
  }

  /** Rollback to last savepoint and replay with correct order */
  private rollbackAndReplay(newOp: Operation): void {
    if (!this.db) return;

    console.log(`[ModuSQL] Rolling back to seq ${this.savepointSeq} and replaying`);

    try {
      // Rollback to savepoint
      this.db.run(`ROLLBACK TO modusql_seq_${this.savepointSeq}`);

      // Re-apply the new confirmed operation
      this.applyOp(newOp);

      // Re-apply pending operations (optimistically)
      for (const pending of this.pendingOps) {
        this.applyOp({
          ...pending,
          seq: 0  // Not confirmed yet
        } as Operation);
      }

      // Create new savepoint after confirmed state
      this.createSavepoint();
    } catch (e) {
      console.error('[ModuSQL] Rollback failed:', e);
      // If rollback fails, we might need a full resync
    }
  }

  /** Create a savepoint at current confirmed state */
  private createSavepoint(): void {
    if (!this.db) return;

    // Release old savepoint if exists
    if (this.savepointSeq > 0) {
      try {
        this.db.run(`RELEASE SAVEPOINT modusql_seq_${this.savepointSeq}`);
      } catch (e) {
        // Savepoint might not exist
      }
    }

    this.savepointSeq = this.confirmedSeq;
    this.db.run(`SAVEPOINT modusql_seq_${this.savepointSeq}`);
  }

  /** Apply a single operation to the database */
  private applyOp(op: Operation | PendingOperation): void {
    switch (op.type) {
      case 'INSERT':
        this.applyInsert(op as Operation);
        break;
      case 'UPDATE':
        this.applyUpdate(op as Operation);
        break;
      case 'DELETE':
        this.applyDelete(op as Operation);
        break;
    }
  }

  private applyInsert(op: Operation): void {
    const data = { ...op.data };
    delete data._where;

    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = columns.map(() => '?').join(', ');

    try {
      this.db!.run(
        `INSERT OR REPLACE INTO ${op.table} (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      );
    } catch (e) {
      console.warn('Failed to apply INSERT:', e);
    }
  }

  private applyUpdate(op: Operation): void {
    const data = { ...op.data };
    const where = data._where || {};
    delete data._where;

    const setClauses = Object.keys(data).map(k => `${k} = ?`).join(', ');
    const whereClauses = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
    const values = [...Object.values(data), ...Object.values(where)];

    try {
      this.db!.run(
        `UPDATE ${op.table} SET ${setClauses} WHERE ${whereClauses}`,
        values
      );
    } catch (e) {
      console.warn('Failed to apply UPDATE:', e);
    }
  }

  private applyDelete(op: Operation): void {
    const where = op.data._where || {};
    const whereClauses = Object.keys(where).map(k => `${k} = ?`).join(' AND ');
    const values = Object.values(where);

    try {
      this.db!.run(`DELETE FROM ${op.table} WHERE ${whereClauses}`, values);
    } catch (e) {
      console.warn('Failed to apply DELETE:', e);
    }
  }

  private createOperation(table: string, type: 'INSERT' | 'UPDATE' | 'DELETE', data: Record<string, any>): PendingOperation {
    this.localSeqCounter++;

    const op: PendingOperation = {
      id: `${this.clientId}_${this.localSeqCounter}_${Date.now()}`,
      localSeq: this.localSeqCounter,
      table,
      type,
      data,
      clientId: this.clientId
    };

    // Store pending operation
    this.pendingOps.push(op);
    this.db!.run(
      `INSERT INTO _modusql_ops (id, local_seq, table_name, op_type, data, client_id, confirmed)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [op.id, op.localSeq, op.table, op.type, JSON.stringify(op.data), op.clientId]
    );

    // Update local seq counter
    this.db!.run(
      `INSERT OR REPLACE INTO _modusql_meta (key, value) VALUES ('local_seq', ?)`,
      [this.localSeqCounter.toString()]
    );

    this.persist();

    // Notify listeners
    if (this.onOperation) {
      this.onOperation(op);
    }

    return op;
  }

  /** Get last confirmed sequence number */
  getLastConfirmedSeq(): number {
    return this.confirmedSeq;
  }

  /** Get pending operations count */
  getPendingCount(): number {
    return this.pendingOps.length;
  }

  /** Close the database */
  close(): void {
    if (this.db) {
      this.persist();
      this.db.close();
      this.db = null;
    }
  }
}

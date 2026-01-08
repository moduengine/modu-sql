/**
 * ModuSQL
 *
 * SQLite + Modu Network for offline-first apps with real-time sync.
 *
 * @example
 * import { ModuSQL } from 'modusql';
 * import { ModuNetwork } from 'modd-network';
 *
 * const db = new ModuSQL({
 *   dbName: 'my-app',
 *   roomId: 'shared-room'
 * });
 *
 * // Local only
 * await db.init();
 *
 * // Or with network sync
 * await db.init(ModuNetwork, 'ws://localhost:8001/ws', {
 *   onRoomCreate: () => console.log('Room created'),
 *   onConnect: (snapshot, ops) => renderUI(),
 *   onInput: (op) => renderUI(),
 *   onDisconnect: () => console.log('Disconnected')
 * });
 *
 * // Define schema
 * db.createTable({
 *   name: 'todos',
 *   columns: [
 *     { name: 'id', type: 'TEXT' },
 *     { name: 'title', type: 'TEXT' },
 *     { name: 'completed', type: 'INTEGER', default: 0 }
 *   ],
 *   primaryKey: 'id'
 * });
 *
 * // CRUD operations (automatically synced)
 * db.insert('todos', { id: '1', title: 'Buy milk', completed: 0 });
 * db.update('todos', { completed: 1 }, { id: '1' });
 * db.delete('todos', { id: '1' });
 *
 * // Query (local only)
 * const todos = db.query('SELECT * FROM todos WHERE completed = 0');
 */

import { Database } from './database';
import { SyncManager } from './sync';
import type {
  ModuSQLConfig,
  ModuSQLCallbacks,
  TableSchema,
  QueryResult
} from './types';

export class ModuSQL {
  private db: Database;
  private sync: SyncManager | null = null;
  private config: ModuSQLConfig;
  private clientId: string;

  constructor(config: ModuSQLConfig = {}) {
    this.config = config;
    this.clientId = this.generateClientId();
    this.db = new Database(config.dbName || 'modusql', this.clientId);
  }

  /** Initialize the database and optionally connect to network */
  async init(ModuNetworkClass?: any, networkUrl?: string, callbacks?: ModuSQLCallbacks): Promise<void> {
    await this.db.init();

    // Set up sync if roomId provided
    if (this.config.roomId) {
      this.sync = new SyncManager(this.db, this.config.roomId, callbacks);

      // Connect to network if class and URL provided
      if (ModuNetworkClass && networkUrl) {
        await this.sync.connect(networkUrl, ModuNetworkClass);
      }
    }
  }

  /** Create a table */
  createTable(schema: TableSchema): void {
    this.db.createTable(schema);
  }

  /** Insert a row (synced) */
  insert(table: string, data: Record<string, any>): void {
    this.db.insert(table, data);
  }

  /** Update rows (synced) */
  update(table: string, data: Record<string, any>, where: Record<string, any>): void {
    this.db.update(table, data, where);
  }

  /** Delete rows (synced) */
  delete(table: string, where: Record<string, any>): void {
    this.db.delete(table, where);
  }

  /** Query rows (local only) */
  query<T = Record<string, any>>(sql: string, params: any[] = []): QueryResult<T> {
    return this.db.query<T>(sql, params);
  }

  /** Check if connected to network */
  get isOnline(): boolean {
    return this.sync?.isOnline || false;
  }

  /** Get number of pending (unconfirmed) operations */
  get pendingCount(): number {
    return this.db.pendingOps.length;
  }

  /** Get client ID */
  get id(): string {
    return this.clientId;
  }

  /** Disconnect and close */
  close(): void {
    this.sync?.disconnect();
    this.db.close();
  }

  private generateClientId(): string {
    // Check for existing client ID in localStorage
    const stored = localStorage.getItem('modusql_client_id');
    if (stored) return stored;

    // Generate new client ID
    const id = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem('modusql_client_id', id);
    return id;
  }
}

// Export types
export type {
  ModuSQLConfig,
  ModuSQLCallbacks,
  TableSchema,
  ColumnDef,
  QueryResult
} from './types';

// Export classes
export { Database } from './database';
export { SyncManager } from './sync';

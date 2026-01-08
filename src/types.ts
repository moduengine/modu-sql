/**
 * ModuSQL Types
 *
 * Core type definitions for the SQLite + sync system.
 */

/** A database operation that can be synced */
export interface Operation {
  id: string;
  seq: number;           // Assigned by authority
  table: string;
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  data: Record<string, any>;
  clientId: string;
  localSeq?: number;     // Local sequence before authority confirmation
}

/** Pending operation (not yet confirmed by authority) */
export interface PendingOperation extends Omit<Operation, 'seq'> {
  localSeq: number;
}

/** Sync state */
export interface SyncState {
  lastConfirmedSeq: number;
  pendingOps: PendingOperation[];
  isOnline: boolean;
}

/** Table schema definition */
export interface TableSchema {
  name: string;
  columns: ColumnDef[];
  primaryKey?: string;
}

/** Column definition */
export interface ColumnDef {
  name: string;
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB';
  nullable?: boolean;
  default?: any;
}

/** ModuSQL configuration */
export interface ModuSQLConfig {
  /** Local database name (for localStorage persistence) */
  dbName?: string;

  /** Room ID for network sync */
  roomId?: string;
}

/** ModuSQL callbacks (passed to init) */
export interface ModuSQLCallbacks {
  /** Room created (first joiner) */
  onRoomCreate?(): void;

  /** Connected to room (received snapshot + pending operations) */
  onConnect?(snapshot: any, operations: Operation[]): void;

  /** Operation received from network (after applying to local DB) */
  onInput?(operation: Operation): void;

  /** Disconnected from network */
  onDisconnect?(): void;
}

/** Query result */
export interface QueryResult<T = Record<string, any>> {
  rows: T[];
  rowsAffected: number;
}

/**
 * ModuSQL Sync
 *
 * Handles synchronization between local SQLite and Modu Network.
 * Operations are sent to the authority node which assigns sequence numbers,
 * then broadcast to all clients for application.
 */

import type { Operation, PendingOperation, ModuSQLCallbacks } from './types';
import type { Database } from './database';

// Modu Network types (peer dependency)
interface NetworkConnection {
  send(data: any): void;
  sendSnapshot(snapshot: any, hash: string): void;
  leaveRoom(): void;
  close(): void;
  connected: boolean;
  clientId: string | null;
}

interface NetworkInput {
  id: string;
  clientId: string;
  type: string;
  data: any;
  seq: number;
}

interface ModuNetwork {
  connect(options: any): Promise<NetworkConnection>;
}

export class SyncManager {
  private db: Database;
  private connection: NetworkConnection | null = null;
  private network: ModuNetwork | null = null;
  private roomId: string;
  private callbacks: ModuSQLCallbacks;
  public isOnline: boolean = false;

  constructor(db: Database, roomId: string, callbacks?: ModuSQLCallbacks) {
    this.db = db;
    this.roomId = roomId;
    this.callbacks = callbacks || {};

    // Listen for local operations - send to network
    this.db.onOperation = (op) => this.handleLocalOperation(op);
  }

  /** Connect to Modu Network */
  async connect(networkUrl: string, ModuNetworkClass: any): Promise<void> {
    this.network = new ModuNetworkClass();

    this.connection = await this.network!.connect({
      url: networkUrl,
      roomId: this.roomId,
      onCreate: () => {
        console.log('[ModuSQL] Room created');
        this.callbacks.onRoomCreate?.();
      },
      onJoin: (snapshot: any, inputs: NetworkInput[]) => {
        console.log('[ModuSQL] Joined room, applying', inputs.length, 'inputs');

        // Convert network inputs to operations
        const operations: Operation[] = [];

        // Apply all inputs in sequence order
        const sorted = [...inputs].sort((a, b) => a.seq - b.seq);
        for (const input of sorted) {
          const op = this.inputToOperation(input);
          if (op) {
            this.db.applyOperation(op);
            operations.push(op);
          }
        }

        // Call onConnect with snapshot and operations
        this.callbacks.onConnect?.(snapshot, operations);
      },
      onInput: (input: NetworkInput) => {
        const op = this.inputToOperation(input);
        if (op) {
          this.db.applyOperation(op);
          this.callbacks.onInput?.(op);
        }
      },
      onDisconnect: () => {
        this.isOnline = false;
        this.callbacks.onDisconnect?.();
      },
      onReconnect: () => {
        this.isOnline = true;
        this.flushPendingOps();
      }
    });

    this.isOnline = true;
    this.flushPendingOps();
  }

  /** Convert network input to operation */
  private inputToOperation(input: NetworkInput): Operation | null {
    if (input.data?.type !== 'sumql_op') return null;

    return {
      ...input.data.operation,
      seq: input.seq
    };
  }

  /** Handle a local operation - send to network */
  private handleLocalOperation(op: PendingOperation): void {
    if (this.connection && this.isOnline) {
      this.connection.send({
        type: 'sumql_op',
        operation: op
      });
    }
  }

  /** Send any pending operations that haven't been sent */
  private flushPendingOps(): void {
    if (!this.connection || !this.isOnline) return;

    for (const op of this.db.pendingOps) {
      this.connection.send({
        type: 'sumql_op',
        operation: op
      });
    }
  }

  /** Disconnect from network */
  disconnect(): void {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    this.isOnline = false;
  }
}

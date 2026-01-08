# ModuSQL

SQLite for the browser with real-time sync. Build offline-first apps that work across tabs and devices.

## Features

- **Offline-first** - Full SQLite database in the browser via sql.js
- **Real-time sync** - Optional network sync via Modu Network
- **Cross-tab sync** - Changes sync instantly across browser tabs
- **Conflict resolution** - Automatic rollback and replay when operation order differs
- **Persistent storage** - Database persists to localStorage
- **Simple API** - Familiar SQL queries with typed results

## Installation

```bash
npm install modu-sql
```

## Quick Start

```typescript
import { ModuSQL } from 'modu-sql';

const db = new ModuSQL({
  dbName: 'my-app',
  roomId: 'shared-room'
});

// Initialize (local only)
await db.init();

// Define schema
db.createTable({
  name: 'todos',
  columns: [
    { name: 'id', type: 'TEXT' },
    { name: 'title', type: 'TEXT' },
    { name: 'completed', type: 'INTEGER', default: 0 }
  ],
  primaryKey: 'id'
});

// CRUD operations
db.insert('todos', { id: '1', title: 'Buy milk', completed: 0 });
db.update('todos', { completed: 1 }, { id: '1' });
db.delete('todos', { id: '1' });

// Query with SQL
const result = db.query<Todo>('SELECT * FROM todos WHERE completed = 0');
console.log(result.rows);
```

## Network Sync

Enable real-time sync across devices with Modu Network:

```typescript
import { ModuSQL } from 'modu-sql';
import { ModuNetwork } from 'modd-network';

const db = new ModuSQL({
  dbName: 'my-app',
  roomId: 'shared-room'
});

await db.init(ModuNetwork, 'ws://localhost:8001/ws', {
  onRoomCreate: () => {
    console.log('Room created - you are the authority');
  },
  onConnect: (snapshot, operations) => {
    console.log(`Connected, received ${operations.length} operations`);
    renderUI();
  },
  onInput: (operation) => {
    console.log('Remote operation:', operation.type, operation.table);
    renderUI();
  },
  onDisconnect: () => {
    console.log('Disconnected - working offline');
  }
});
```

## API Reference

### Constructor

```typescript
new ModuSQL(config?: ModuSQLConfig)
```

| Option | Type | Description |
|--------|------|-------------|
| `dbName` | `string` | Database name for localStorage persistence (default: `'modusql'`) |
| `roomId` | `string` | Room ID for network sync |

### Methods

#### `init(ModuNetworkClass?, networkUrl?, callbacks?): Promise<void>`

Initialize the database. Optionally connect to network for sync.

#### `createTable(schema: TableSchema): void`

Create a table with the given schema.

```typescript
db.createTable({
  name: 'users',
  columns: [
    { name: 'id', type: 'TEXT' },
    { name: 'email', type: 'TEXT', nullable: false },
    { name: 'created_at', type: 'INTEGER', default: 0 }
  ],
  primaryKey: 'id'
});
```

Column types: `TEXT`, `INTEGER`, `REAL`, `BLOB`

#### `insert(table: string, data: Record<string, any>): void`

Insert a row.

#### `update(table: string, data: Record<string, any>, where: Record<string, any>): void`

Update rows matching the where clause.

#### `delete(table: string, where: Record<string, any>): void`

Delete rows matching the where clause.

#### `query<T>(sql: string, params?: any[]): QueryResult<T>`

Execute a SQL query and return typed results.

```typescript
const result = db.query<User>('SELECT * FROM users WHERE email = ?', ['user@example.com']);
console.log(result.rows); // User[]
```

#### `close(): void`

Disconnect and close the database.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique client ID (persisted across sessions) |
| `isOnline` | `boolean` | Whether connected to network |
| `pendingCount` | `number` | Number of unconfirmed operations |

## How Sync Works

ModuSQL uses an authority-based sync model:

1. **Local operations** are applied immediately (optimistic updates)
2. **Operations are sent** to the authority node which assigns sequence numbers
3. **Authority broadcasts** operations to all clients in deterministic order
4. **Clients apply** operations and rollback/replay if order differs from optimistic

This ensures all clients converge to the same state while maintaining responsiveness.

## License

MIT

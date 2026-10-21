import { DatabaseSync } from "node:sqlite";

export type OrderStatus = "pending" | "paid";
export type TransactionStatus = "matched" | "unmatched" | "ignored";

export interface Order {
	id: number;
	memo: string;
	amount: number;
	status: OrderStatus;
	transaction_id: number | null;
	created_at: string;
	paid_at: string | null;
}

export interface Transaction {
	id: number;
	order_id: number | null;
	status: TransactionStatus;
	reason: string | null;
	amount: number;
	content: string;
	reference_code: string | null;
	payload: string;
	received_at: string;
}

export function openDb(path = ":memory:"): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS orders (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			memo TEXT NOT NULL UNIQUE,
			amount INTEGER NOT NULL CHECK (amount > 0),
			status TEXT NOT NULL DEFAULT 'pending',
			transaction_id INTEGER UNIQUE,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			paid_at TEXT
		);
		-- One row per SePay transaction id. The primary key is the idempotency guard:
		-- SePay retries up to 7 times, so the same id can arrive more than once.
		CREATE TABLE IF NOT EXISTS transactions (
			id INTEGER PRIMARY KEY,
			order_id INTEGER REFERENCES orders(id),
			status TEXT NOT NULL,
			reason TEXT,
			amount INTEGER NOT NULL,
			content TEXT NOT NULL,
			reference_code TEXT,
			payload TEXT NOT NULL,
			received_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS transactions_status ON transactions(status);
	`);
	return db;
}

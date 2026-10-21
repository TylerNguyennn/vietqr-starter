import { timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Order, Transaction, TransactionStatus } from "./db.js";
import { buildQrUrl, extractMemo, generateMemo } from "./vietqr.js";

export interface Config {
	bankId: string;
	accountNo: string;
	accountName?: string;
	memoPrefix: string;
	sepayApiKey: string;
	adminApiKey: string;
}

// Payload documented at https://docs.sepay.vn/tich-hop-webhooks.html
export interface SepayWebhook {
	id: number;
	gateway: string;
	transactionDate: string;
	accountNumber: string;
	subAccount: string | null;
	code: string | null;
	content: string;
	transferType: "in" | "out";
	description: string;
	transferAmount: number;
	accumulated: number;
	referenceCode: string | null;
}

function safeEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function isSepayWebhook(body: unknown): body is SepayWebhook {
	const b = body as Partial<SepayWebhook> | null;
	return (
		typeof b === "object" &&
		b !== null &&
		Number.isInteger(b.id) &&
		Number.isInteger(b.transferAmount) &&
		typeof b.content === "string" &&
		(b.transferType === "in" || b.transferType === "out")
	);
}

export function createApp(db: DatabaseSync, config: Config): Hono {
	const app = new Hono();

	const qrFor = (order: Order) =>
		buildQrUrl({
			bankId: config.bankId,
			accountNo: config.accountNo,
			accountName: config.accountName,
			amount: order.amount,
			memo: order.memo,
		});

	app.post("/orders", async (c) => {
		const body = await c.req.json().catch(() => null);
		const amount = body?.amount;
		if (!Number.isInteger(amount) || amount <= 0) {
			return c.json({ error: "amount must be a positive integer in VND" }, 400);
		}
		// Retry on the (very unlikely) memo collision instead of failing the request.
		for (let attempt = 0; attempt < 5; attempt++) {
			const memo = generateMemo(config.memoPrefix);
			const result = db.prepare("INSERT OR IGNORE INTO orders (memo, amount) VALUES (?, ?)").run(memo, amount);
			if (result.changes === 1) {
				const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(result.lastInsertRowid) as unknown as Order;
				return c.json({ ...order, qr_url: qrFor(order) }, 201);
			}
		}
		return c.json({ error: "could not allocate a unique memo" }, 500);
	});

	app.get("/orders/:id", (c) => {
		const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(c.req.param("id"))) as unknown as Order | undefined;
		if (!order) return c.json({ error: "not found" }, 404);
		return c.json({ ...order, qr_url: qrFor(order) });
	});

	app.post("/webhooks/sepay", async (c) => {
		// SePay "API Key" auth sends: Authorization: Apikey <key>
		const auth = c.req.header("authorization") ?? "";
		if (!safeEqual(auth, `Apikey ${config.sepayApiKey}`)) {
			return c.json({ success: false, error: "unauthorized" }, 401);
		}
		const body = await c.req.json().catch(() => null);
		if (!isSepayWebhook(body)) {
			return c.json({ success: false, error: "invalid payload" }, 400);
		}

		const outcome = recordTransaction(db, config, body);
		// SePay treats anything other than 200/201 + {"success": true} as a failure and retries.
		// Unmatched money is still "received": we store it for reconciliation and acknowledge it.
		return c.json({ success: true, ...outcome });
	});

	app.get("/reconciliation/unmatched", (c) => {
		if (!safeEqual(c.req.header("x-admin-key") ?? "", config.adminApiKey)) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const rows = db
			.prepare("SELECT id, status, reason, amount, content, reference_code, received_at FROM transactions WHERE status = 'unmatched' ORDER BY received_at")
			.all() as unknown as Transaction[];
		return c.json({ transactions: rows });
	});

	return app;
}

export interface Outcome {
	status: TransactionStatus | "duplicate";
	reason?: string;
	order_id?: number;
}

export function recordTransaction(db: DatabaseSync, config: Config, tx: SepayWebhook): Outcome {
	db.exec("BEGIN IMMEDIATE");
	try {
		const outcome = decide(db, config, tx);
		if (outcome.status !== "duplicate") {
			db.prepare(
				"INSERT INTO transactions (id, order_id, status, reason, amount, content, reference_code, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			).run(tx.id, outcome.order_id ?? null, outcome.status, outcome.reason ?? null, tx.transferAmount, tx.content, tx.referenceCode, JSON.stringify(tx));
			if (outcome.status === "matched") {
				db.prepare("UPDATE orders SET status = 'paid', transaction_id = ?, paid_at = datetime('now') WHERE id = ?").run(tx.id, outcome.order_id!);
			}
		}
		db.exec("COMMIT");
		return outcome;
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function decide(db: DatabaseSync, config: Config, tx: SepayWebhook): Outcome {
	if (db.prepare("SELECT 1 FROM transactions WHERE id = ?").get(tx.id)) {
		return { status: "duplicate" };
	}
	if (tx.transferType !== "in") {
		return { status: "ignored", reason: "outgoing_transfer" };
	}
	if (tx.accountNumber && tx.accountNumber !== config.accountNo) {
		return { status: "unmatched", reason: "wrong_account" };
	}
	// SePay fills `code` when it recognises your payment-code pattern; otherwise parse the memo ourselves.
	const memo = extractMemo(tx.code ?? "", config.memoPrefix) ?? extractMemo(tx.content, config.memoPrefix);
	if (!memo) return { status: "unmatched", reason: "no_memo" };

	const order = db.prepare("SELECT * FROM orders WHERE memo = ?").get(memo) as unknown as Order | undefined;
	if (!order) return { status: "unmatched", reason: "unknown_memo" };
	if (order.status === "paid") return { status: "unmatched", reason: "order_already_paid", order_id: order.id };
	if (tx.transferAmount !== order.amount) {
		return { status: "unmatched", reason: tx.transferAmount < order.amount ? "underpaid" : "overpaid", order_id: order.id };
	}
	return { status: "matched", order_id: order.id };
}

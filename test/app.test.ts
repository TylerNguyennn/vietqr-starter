import { beforeEach, describe, expect, it } from "vitest";
import { type Config, createApp, type SepayWebhook } from "../src/app.js";
import { openDb } from "../src/db.js";
import { buildQrUrl, extractMemo, generateMemo } from "../src/vietqr.js";

const config: Config = {
	bankId: "TCB",
	accountNo: "19000000000",
	accountName: "TEST SHOP",
	memoPrefix: "DH",
	sepayApiKey: "test-key",
	adminApiKey: "admin-key",
};

let app: ReturnType<typeof createApp>;
let nextTxId = 1000;

beforeEach(() => {
	app = createApp(openDb(), config);
});

async function createOrder(amount: number) {
	const res = await app.request("/orders", { method: "POST", body: JSON.stringify({ amount }), headers: { "content-type": "application/json" } });
	return { res, order: await res.json() };
}

function webhook(overrides: Partial<SepayWebhook>, auth = "Apikey test-key") {
	const body: SepayWebhook = {
		id: nextTxId++,
		gateway: "Techcombank",
		transactionDate: "2026-10-21 09:30:00",
		accountNumber: "19000000000",
		subAccount: "",
		code: null,
		content: "",
		transferType: "in",
		description: "",
		transferAmount: 0,
		accumulated: 0,
		referenceCode: "FT26294000001",
		...overrides,
	};
	return app.request("/webhooks/sepay", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", authorization: auth } });
}

async function getOrder(id: number) {
	return (await app.request(`/orders/${id}`)).json();
}

describe("vietqr helpers", () => {
	it("builds an img.vietqr.io quick link", () => {
		const url = new URL(buildQrUrl({ bankId: "TCB", accountNo: "123", amount: 50000, memo: "DHABC23456" }));
		expect(url.host).toBe("img.vietqr.io");
		expect(url.pathname).toBe("/image/TCB-123-compact2.png");
		expect(url.searchParams.get("amount")).toBe("50000");
		expect(url.searchParams.get("addInfo")).toBe("DHABC23456");
	});

	it("rejects memos with special characters", () => {
		expect(() => buildQrUrl({ bankId: "TCB", accountNo: "1", amount: 1, memo: "DH-1" })).toThrow();
	});

	it("finds the memo inside bank-rewritten content", () => {
		const memo = generateMemo("DH");
		expect(extractMemo(`MBVCB.123.TRAN VAN B chuyen tien ${memo.toLowerCase()}.CT tu 0123`, "DH")).toBe(memo);
		expect(extractMemo("thanh toan don hang", "DH")).toBeNull();
	});
});

describe("orders", () => {
	it("creates an order with a unique memo and QR url", async () => {
		const { res, order } = await createOrder(150000);
		expect(res.status).toBe(201);
		expect(order.status).toBe("pending");
		expect(order.memo).toMatch(/^DH[A-Z0-9]{8}$/);
		expect(order.qr_url).toContain(`addInfo=${order.memo}`);
		const { order: second } = await createOrder(150000);
		expect(second.memo).not.toBe(order.memo);
	});

	it("rejects non-integer amounts", async () => {
		expect((await createOrder(10.5)).res.status).toBe(400);
	});
});

describe("SePay webhook", () => {
	it("rejects a wrong API key", async () => {
		const res = await webhook({}, "Apikey nope");
		expect(res.status).toBe(401);
	});

	it("marks the order paid when memo and amount match", async () => {
		const { order } = await createOrder(150000);
		const res = await webhook({ content: `TRAN VAN B ${order.memo} thanh toan`, transferAmount: 150000 });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ success: true, status: "matched", order_id: order.id });
		expect((await getOrder(order.id)).status).toBe("paid");
	});

	it("prefers SePay's parsed code when present", async () => {
		const { order } = await createOrder(1000);
		const res = await webhook({ code: order.memo, content: "garbled", transferAmount: 1000 });
		expect(await res.json()).toMatchObject({ status: "matched" });
	});

	it("is idempotent on the SePay transaction id", async () => {
		const { order } = await createOrder(150000);
		const payload = { id: 777, content: order.memo, transferAmount: 150000 };
		await webhook(payload);
		const retry = await webhook(payload);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual({ success: true, status: "duplicate" });
	});

	it("keeps underpayments as unmatched and leaves the order pending", async () => {
		const { order } = await createOrder(150000);
		const res = await webhook({ content: order.memo, transferAmount: 100000 });
		expect(await res.json()).toMatchObject({ success: true, status: "unmatched", reason: "underpaid" });
		expect((await getOrder(order.id)).status).toBe("pending");
	});

	it("flags a second payment for an already-paid order", async () => {
		const { order } = await createOrder(5000);
		await webhook({ content: order.memo, transferAmount: 5000 });
		const res = await webhook({ content: order.memo, transferAmount: 5000 });
		expect(await res.json()).toMatchObject({ status: "unmatched", reason: "order_already_paid" });
	});

	it("ignores outgoing transfers", async () => {
		const res = await webhook({ transferType: "out", transferAmount: 10 });
		expect(await res.json()).toMatchObject({ status: "ignored" });
	});

	it("lists unmatched transfers for reconciliation", async () => {
		await webhook({ content: "no memo here", transferAmount: 20000 });
		await webhook({ content: "DHZZZZZZZZ", transferAmount: 20000 });
		expect((await app.request("/reconciliation/unmatched")).status).toBe(401);
		const res = await app.request("/reconciliation/unmatched", { headers: { "x-admin-key": "admin-key" } });
		const { transactions } = await res.json();
		expect(transactions.map((t: { reason: string }) => t.reason)).toEqual(["no_memo", "unknown_memo"]);
	});
});

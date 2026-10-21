import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db.js";

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing env var ${name}`);
	return value;
}

const app = createApp(openDb(process.env.DATABASE_PATH ?? "./data.sqlite"), {
	bankId: required("BANK_ID"),
	accountNo: required("BANK_ACCOUNT_NO"),
	accountName: process.env.BANK_ACCOUNT_NAME,
	memoPrefix: process.env.MEMO_PREFIX ?? "DH",
	sepayApiKey: required("SEPAY_WEBHOOK_API_KEY"),
	adminApiKey: required("ADMIN_API_KEY"),
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port });
console.log(`vietqr-starter listening on :${port}`);

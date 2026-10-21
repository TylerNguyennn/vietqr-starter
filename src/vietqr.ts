import { randomInt } from "node:crypto";

// Quick-link format documented at https://www.vietqr.io/danh-sach-api/link-tao-ma-nhanh/
//   https://img.vietqr.io/image/<BANK_ID>-<ACCOUNT_NO>-<TEMPLATE>.png?amount=&addInfo=&accountName=
// addInfo: max 50 chars, no special characters. accountName is display-only (not part of the VietQR standard).

export type QrTemplate = "compact2" | "compact" | "qr_only" | "print";

export interface QrInput {
	bankId: string;
	accountNo: string;
	accountName?: string;
	amount: number;
	memo: string;
	template?: QrTemplate;
}

export function buildQrUrl({ bankId, accountNo, accountName, amount, memo, template = "compact2" }: QrInput): string {
	if (!Number.isInteger(amount) || amount <= 0 || String(amount).length > 13) {
		throw new Error("amount must be a positive integer (VND) with at most 13 digits");
	}
	if (!/^[A-Za-z0-9 ]{1,50}$/.test(memo)) {
		throw new Error("memo must be 1-50 letters, digits or spaces");
	}
	const url = new URL(`https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-${template}.png`);
	url.searchParams.set("amount", String(amount));
	url.searchParams.set("addInfo", memo);
	if (accountName) url.searchParams.set("accountName", accountName);
	return url.toString();
}

// No 0/O/1/I so the memo survives being typed by hand in a banking app.
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function generateMemo(prefix: string, length = 8): string {
	let code = "";
	for (let i = 0; i < length; i++) code += ALPHABET[randomInt(ALPHABET.length)];
	return `${prefix}${code}`;
}

// Banks often rewrite the memo (prepend sender info, add separators, change case),
// so search the whole content instead of expecting an exact match.
export function extractMemo(content: string, prefix: string, length = 8): string | null {
	const normalized = content.toUpperCase().replace(/[^A-Z0-9]/g, " ");
	const match = normalized.match(new RegExp(`\\b${prefix.toUpperCase()}[${ALPHABET}]{${length}}\\b`));
	return match ? match[0] : null;
}

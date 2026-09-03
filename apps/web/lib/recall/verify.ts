import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;
const WHSEC_PREFIX = "whsec_";

function getHeader(
	headers: Headers | Record<string, string>,
	name: string,
): string | null {
	if (headers instanceof Headers) return headers.get(name);
	const entry = Object.entries(headers).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	);
	return entry ? entry[1] : null;
}

export function verifyRecallSignature({
	secret,
	headers,
	payload,
}: {
	secret: string;
	headers: Headers | Record<string, string>;
	payload: string | null;
}): boolean {
	if (payload === null) return false;

	const id = getHeader(headers, "webhook-id") ?? getHeader(headers, "svix-id");
	const timestamp =
		getHeader(headers, "webhook-timestamp") ??
		getHeader(headers, "svix-timestamp");
	const signatureHeader =
		getHeader(headers, "webhook-signature") ??
		getHeader(headers, "svix-signature");
	if (!id || !timestamp || !signatureHeader) return false;

	if (!/^\d+$/.test(timestamp)) return false;
	const timestampSeconds = Number(timestamp);
	if (!Number.isSafeInteger(timestampSeconds)) return false;
	const nowSeconds = Math.floor(Date.now() / 1000);
	if (Math.abs(nowSeconds - timestampSeconds) > TOLERANCE_SECONDS) return false;

	const secretKey = secret.startsWith(WHSEC_PREFIX)
		? secret.slice(WHSEC_PREFIX.length)
		: secret;
	const key = Buffer.from(secretKey, "base64");
	const expected = createHmac("sha256", key)
		.update(`${id}.${timestamp}.${payload}`)
		.digest("base64");
	const expectedBuffer = Buffer.from(expected, "base64");

	return signatureHeader.split(" ").some((entry) => {
		const [version, signature] = entry.split(",");
		if (version !== "v1" || !signature) return false;
		const signatureBuffer = Buffer.from(signature, "base64");
		return (
			expectedBuffer.length === signatureBuffer.length &&
			timingSafeEqual(expectedBuffer, signatureBuffer)
		);
	});
}

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type NodeReadableWebStream = Parameters<typeof Readable.fromWeb>[0];

function recordingCopyError(message: string): Error {
	return new Error(message);
}

function rejectNonVideoContentType(contentType: string): void {
	if (
		contentType.includes("text/html") ||
		contentType.includes("application/json")
	) {
		throw recordingCopyError(
			`Recording download returned non-video content (${contentType.split(";")[0]})`,
		);
	}
}

function rejectOverLimitBytes(byteCount: number, label: string): void {}

export async function copyRemoteVideoToPresignedPut({
	downloadUrl,
	putUrl,
}: {
	downloadUrl: string;
	putUrl: string;
}): Promise<number> {
	const download = await fetch(downloadUrl);
	if (!download.ok) {
		throw recordingCopyError(`Recording download failed (${download.status})`);
	}

	rejectNonVideoContentType(download.headers.get("content-type") ?? "");

	const contentLengthHeader = download.headers.get("content-length");
	if (contentLengthHeader !== null) {
		const contentLength = Number(contentLengthHeader);
		if (Number.isFinite(contentLength)) {
			rejectOverLimitBytes(contentLength, "content-length");
		}
	}

	if (!download.body) {
		throw recordingCopyError("Recording download body is missing");
	}

	const tempPath = join(tmpdir(), `recall-recording-${randomUUID()}.mp4`);
	try {
		await pipeline(
			Readable.fromWeb(download.body as NodeReadableWebStream),
			createWriteStream(tempPath),
		);

		const { size } = await stat(tempPath);
		rejectOverLimitBytes(size, "file");
		console.info("[recall] copied recording bytes", { bytes: size });

		const upload = await fetch(putUrl, {
			method: "PUT",
			headers: {
				"Content-Type": "video/mp4",
				"Content-Length": String(size),
			},
			body: Readable.toWeb(createReadStream(tempPath)),
			duplex: "half",
		} as RequestInit);

		if (!upload.ok) {
			throw recordingCopyError(`Recording upload failed (${upload.status})`);
		}

		return size;
	} finally {
		await unlink(tempPath).catch(() => undefined);
	}
}

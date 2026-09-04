"use client";

import { Button, Card, CardHeader, CardTitle } from "@cap/ui";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CAP_CHROME_EXTENSION_URL } from "@/lib/chrome-extension";

function UrlCopyField({ url }: { url: string }) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(url);
		setCopied(true);
		toast.success("Copied to clipboard");
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="flex gap-2 items-center">
			<code className="flex-1 px-3 py-2 text-xs rounded-lg bg-gray-3 text-gray-11 font-mono truncate">
				{url}
			</code>
			<button
				type="button"
				onClick={handleCopy}
				aria-label="Copy server URL"
				className="p-1.5 rounded-md hover:bg-gray-3 text-gray-10 transition-colors"
			>
				{copied ? (
					<Check size={14} className="text-green-400" />
				) : (
					<Copy size={14} />
				)}
			</button>
		</div>
	);
}

export function AppsPage({ webUrl }: { webUrl: string }) {
	return (
		<div className="flex flex-col gap-4">
			<Card>
				<CardHeader>
					<CardTitle>Desktop (macOS/Windows)</CardTitle>
				</CardHeader>
				<div className="flex flex-col gap-4 mt-3">
					<Button
						href="https://cap.so/download"
						target="_blank"
						size="sm"
						className="self-start"
					>
						Download Cap
					</Button>
					<ol className="flex flex-col gap-3 pl-4 text-sm list-decimal text-gray-11">
						<li>Open Cap and go to Settings → General.</li>
						<li>
							In the Self-host section, set the Cap Server URL to this instance:
							<div className="mt-2">
								<UrlCopyField url={webUrl} />
							</div>
						</li>
						<li>Confirm the change, then sign in again with Google.</li>
					</ol>
				</div>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Mobile (iOS)</CardTitle>
				</CardHeader>
				<div className="flex flex-col gap-3 mt-3 text-sm text-gray-11">
					<p>
						Mobile is not supported right now. The Cap app on the App Store does
						not allow the server URL to be changed, so it cannot connect to this
						instance. If there is a need for it, we can build the app ourselves
						and distribute it internally, but as of now we are not doing that.
					</p>
				</div>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Browser extension</CardTitle>
				</CardHeader>
				<div className="flex flex-col gap-4 mt-3">
					<Button
						href={CAP_CHROME_EXTENSION_URL}
						target="_blank"
						size="sm"
						className="self-start"
					>
						Get the extension
					</Button>
					<ol className="flex flex-col gap-3 pl-4 text-sm list-decimal text-gray-11">
						<li>Install the extension, then open its options page.</li>
						<li>
							Under Connection, set the Cap URL to this instance:
							<div className="mt-2">
								<UrlCopyField url={webUrl} />
							</div>
						</li>
						<li>Sign in with Google.</li>
					</ol>
				</div>
			</Card>
		</div>
	);
}

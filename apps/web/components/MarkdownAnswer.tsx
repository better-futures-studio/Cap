"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Matches the `[mm:ss]` / `[h:mm:ss]` markers the backend embeds in answers. */
const TIME_MARKER = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g;

const parseMarkerSeconds = (marker: string): number | null => {
	const parts = marker.split(":").map((part) => Number(part));
	if (parts.length < 2 || parts.length > 3) return null;
	if (parts.some((part) => Number.isNaN(part))) return null;
	return parts.reduce((total, part) => total * 60 + part, 0);
};

/** Rewrites `[mm:ss]` markers into markdown links so they survive rendering as chips. */
const linkifyMarkers = (content: string): string =>
	content.replace(TIME_MARKER, (full, marker: string) => {
		const seconds = parseMarkerSeconds(marker);
		return seconds === null ? full : `[${full}](#t=${seconds})`;
	});

const PROSE_CLASSES =
	"prose prose-sm prose-gray max-w-none prose-p:my-2 prose-ul:my-2 prose-li:my-0 prose-strong:text-gray-12";

export const MarkdownAnswer = ({
	content,
	onSeek,
	className = "",
}: {
	content: string;
	onSeek?: (time: number) => void;
	className?: string;
}) => {
	return (
		<div className={`${PROSE_CLASSES} text-sm ${className}`.trim()}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => {
						if (href?.startsWith("#t=")) {
							const seconds = Number(href.slice(3));
							return (
								<button
									type="button"
									onClick={(event) => {
										event.preventDefault();
										onSeek?.(seconds);
									}}
									className="mx-0.5 inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-blue-600 no-underline transition hover:bg-blue-100"
								>
									{children}
								</button>
							);
						}
						return (
							<a href={href} target="_blank" rel="noreferrer">
								{children}
							</a>
						);
					},
				}}
			>
				{linkifyMarkers(content)}
			</ReactMarkdown>
		</div>
	);
};

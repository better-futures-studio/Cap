"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { LoaderCircle, Send } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { type AskVideoMessage, askVideo } from "@/actions/videos/ask";

interface AskProps {
	videoId: Video.VideoId;
	onSeek?: (time: number) => void;
}

const MAX_HISTORY_TURNS = 10;

const SUGGESTED_QUESTIONS = [
	"What were the key decisions?",
	"List the action items and who owns them",
	"Summarize what was said about …",
] as const;

/** Matches the `[mm:ss]` / `[h:mm:ss]` markers the backend embeds in answers. */
const TIME_MARKER = /(\[(?:\d{1,2}:)?\d{1,2}:\d{2}\])/g;

const parseMarkerSeconds = (marker: string): number | null => {
	const parts = marker
		.slice(1, -1)
		.split(":")
		.map((part) => Number(part));
	if (parts.length < 2 || parts.length > 3) return null;
	if (parts.some((part) => Number.isNaN(part))) return null;
	return parts.reduce((total, part) => total * 60 + part, 0);
};

const AnswerText = ({
	content,
	onSeek,
}: {
	content: string;
	onSeek?: (time: number) => void;
}) => {
	const paragraphs = content.split(/\n{2,}/).filter((p) => p.trim());

	return (
		<div className="space-y-2">
			{paragraphs.map((paragraph, pIndex) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: paragraphs are static once rendered
				<p key={pIndex} className="text-sm leading-relaxed text-gray-12">
					{paragraph.split(TIME_MARKER).map((part, index) => {
						// split() on a single-capture-group regex puts each match at an
						// odd index; only those parts are candidate `[mm:ss]` markers.
						const seconds = index % 2 === 1 ? parseMarkerSeconds(part) : null;
						if (seconds !== null) {
							return (
								<button
									// biome-ignore lint/suspicious/noArrayIndexKey: parts are static once rendered
									key={index}
									type="button"
									onClick={() => onSeek?.(seconds)}
									className="mx-0.5 inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-blue-600 transition hover:bg-blue-100"
								>
									{part}
								</button>
							);
						}
						// biome-ignore lint/suspicious/noArrayIndexKey: parts are static once rendered
						return <span key={index}>{part}</span>;
					})}
				</p>
			))}
		</div>
	);
};

export const Ask: React.FC<AskProps> = ({ videoId, onSeek }) => {
	const [messages, setMessages] = useState<AskVideoMessage[]>([]);
	const [input, setInput] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	const send = async (question: string) => {
		const trimmed = question.trim();
		if (!trimmed || isLoading) return;

		const history = messages.slice(-MAX_HISTORY_TURNS);
		const nextMessages: AskVideoMessage[] = [
			...messages,
			{ role: "user", content: trimmed },
		];
		setMessages(nextMessages);
		setInput("");
		setError(null);
		setIsLoading(true);

		try {
			const result = await askVideo({ videoId, question: trimmed, history });
			setMessages([
				...nextMessages,
				{ role: "assistant", content: result.answer },
			]);
		} catch (err) {
			console.error("[Ask] askVideo failed:", err);
			setMessages(nextMessages);
			setError(trimmed);
			toast.error("Couldn't get an answer. Try again?");
		} finally {
			setIsLoading(false);
		}
	};

	const handleSubmit = () => void send(input);

	const handleSuggestion = (question: string, autoSend: boolean) => {
		if (autoSend) {
			void send(question);
			return;
		}
		setInput(question);
		textareaRef.current?.focus();
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex-1 overflow-y-auto p-4">
				{messages.length === 0 ? (
					<div className="flex h-full flex-col justify-center gap-3">
						<p className="text-center text-sm text-gray-10">
							Ask a question about this recording
						</p>
						<div className="flex flex-col gap-2">
							{SUGGESTED_QUESTIONS.map((question, index) => (
								<button
									key={question}
									type="button"
									onClick={() => handleSuggestion(question, index !== 2)}
									className="rounded-lg border border-gray-4 px-3 py-2 text-left text-sm text-gray-11 transition hover:bg-gray-2 hover:text-gray-12"
								>
									{question}
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="space-y-4">
						{messages.map((message, index) => (
							<div
								key={`${message.role}-${index}`}
								className={
									message.role === "user"
										? "flex justify-end"
										: "flex justify-start"
								}
							>
								{message.role === "user" ? (
									<div className="max-w-[85%] rounded-lg bg-gray-3 px-3 py-2 text-sm text-gray-12">
										{message.content}
									</div>
								) : (
									<div className="max-w-[85%]">
										<AnswerText content={message.content} onSeek={onSeek} />
									</div>
								)}
							</div>
						))}
						{isLoading && (
							<div className="flex items-center gap-2 text-sm text-gray-9">
								<LoaderCircle className="size-3.5 animate-spin" />
								Thinking…
							</div>
						)}
						{error && !isLoading && (
							<div className="flex justify-start">
								<Button
									variant="gray"
									size="sm"
									onClick={() => void send(error)}
								>
									Retry
								</Button>
							</div>
						)}
					</div>
				)}
			</div>

			<div className="flex flex-none items-end gap-2 border-t border-gray-3 p-3">
				<textarea
					ref={textareaRef}
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={handleKeyDown}
					disabled={isLoading}
					placeholder="Ask about this recording…"
					rows={1}
					className="min-h-9 flex-1 resize-none rounded-lg border border-gray-4 bg-gray-1 px-3 py-2 text-sm text-gray-12 outline-none transition placeholder:text-gray-8 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60"
				/>
				<Button
					variant="dark"
					size="icon"
					onClick={handleSubmit}
					disabled={isLoading || !input.trim()}
					aria-label="Send question"
				>
					{isLoading ? (
						<LoaderCircle className="size-3.5 animate-spin" />
					) : (
						<Send className="size-3.5" />
					)}
				</Button>
			</div>
		</div>
	);
};

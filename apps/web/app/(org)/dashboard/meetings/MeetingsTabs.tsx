"use client";

import { classNames } from "@cap/utils";
import { useRef } from "react";

export interface MeetingsTab {
	key: string;
	label: string;
	count?: number;
}

export function MeetingsTabs({
	tabs,
	active,
	onChange,
}: {
	tabs: MeetingsTab[];
	active: string;
	onChange: (key: string) => void;
}) {
	const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

	const focusTab = (index: number) => {
		const tab = tabs[(index + tabs.length) % tabs.length];
		if (!tab) return;
		onChange(tab.key);
		buttonRefs.current.get(tab.key)?.focus();
	};

	const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
		if (event.key === "ArrowRight") {
			event.preventDefault();
			focusTab(index + 1);
		} else if (event.key === "ArrowLeft") {
			event.preventDefault();
			focusTab(index - 1);
		}
	};

	return (
		<div
			role="tablist"
			aria-label="Meetings"
			className="inline-flex items-center gap-0.5 self-start rounded-full border border-gray-5 bg-gray-3 p-0.5"
		>
			{tabs.map((tab, index) => {
				const isActive = tab.key === active;
				return (
					<button
						key={tab.key}
						ref={(el) => {
							if (el) buttonRefs.current.set(tab.key, el);
							else buttonRefs.current.delete(tab.key);
						}}
						type="button"
						role="tab"
						aria-selected={isActive}
						tabIndex={isActive ? 0 : -1}
						onClick={() => onChange(tab.key)}
						onKeyDown={(event) => handleKeyDown(event, index)}
						className={classNames(
							"rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-150",
							"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9",
							isActive
								? "bg-gray-1 text-gray-12 shadow-sm"
								: "text-gray-11 hover:text-gray-12",
						)}
					>
						{tab.label}
						{tab.count !== undefined && (
							<span className="ml-1 text-gray-9">{tab.count}</span>
						)}
					</button>
				);
			})}
		</div>
	);
}

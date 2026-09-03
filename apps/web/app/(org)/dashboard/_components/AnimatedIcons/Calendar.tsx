"use client";

import { motion, useAnimation } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface CalendarIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface CalendarIconProps extends HTMLAttributes<HTMLDivElement> {
	size?: number;
}

const CalendarIcon = forwardRef<CalendarIconHandle, CalendarIconProps>(
	({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
		const controls = useAnimation();
		const isControlledRef = useRef(false);

		useImperativeHandle(ref, () => {
			isControlledRef.current = true;

			return {
				startAnimation: () => controls.start("animate"),
				stopAnimation: () => controls.start("normal"),
			};
		});

		const handleMouseEnter = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (!isControlledRef.current) {
					controls.start("animate");
				} else {
					onMouseEnter?.(e);
				}
			},
			[controls, onMouseEnter],
		);

		const handleMouseLeave = useCallback(
			(e: React.MouseEvent<HTMLDivElement>) => {
				if (!isControlledRef.current) {
					controls.start("normal");
				} else {
					onMouseLeave?.(e);
				}
			},
			[controls, onMouseLeave],
		);

		return (
			<div
				className={cn(className)}
				onMouseEnter={handleMouseEnter}
				onMouseLeave={handleMouseLeave}
				{...props}
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width={size}
					height={size}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<rect x="3" y="4" width="18" height="18" rx="2" />
					<line x1="3" y1="9" x2="21" y2="9" />
					<motion.line
						x1="8"
						x2="8"
						y1="2"
						y2="6"
						variants={{
							normal: { y1: 2, y2: 6 },
							animate: { y1: 1, y2: 7 },
						}}
						animate={controls}
						transition={{ type: "spring", stiffness: 300, damping: 10 }}
					/>
					<motion.line
						x1="16"
						x2="16"
						y1="2"
						y2="6"
						variants={{
							normal: { y1: 2, y2: 6 },
							animate: { y1: 1, y2: 7 },
						}}
						animate={controls}
						transition={{ type: "spring", stiffness: 300, damping: 10 }}
					/>
					<motion.circle
						cx="8"
						cy="14"
						r="1"
						fill="currentColor"
						variants={{
							normal: { opacity: 1, scale: 1 },
							animate: { opacity: [1, 0.3, 1], scale: [1, 1.3, 1] },
						}}
						animate={controls}
						transition={{ duration: 0.6, ease: "easeInOut" }}
					/>
					<motion.circle
						cx="12"
						cy="14"
						r="1"
						fill="currentColor"
						variants={{
							normal: { opacity: 1, scale: 1 },
							animate: { opacity: [1, 0.3, 1], scale: [1, 1.3, 1] },
						}}
						animate={controls}
						transition={{ duration: 0.6, ease: "easeInOut", delay: 0.1 }}
					/>
					<motion.circle
						cx="16"
						cy="14"
						r="1"
						fill="currentColor"
						variants={{
							normal: { opacity: 1, scale: 1 },
							animate: { opacity: [1, 0.3, 1], scale: [1, 1.3, 1] },
						}}
						animate={controls}
						transition={{ duration: 0.6, ease: "easeInOut", delay: 0.2 }}
					/>
				</svg>
			</div>
		);
	},
);

CalendarIcon.displayName = "CalendarIcon";

export default CalendarIcon;

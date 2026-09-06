import { type MotionProps, motion, type Variants } from "framer-motion";
import React, { forwardRef, useImperativeHandle } from "react";

const sparklesVariants: Variants = {
	normal: {
		scale: 1,
		rotate: 0,
	},
	animate: {
		scale: [1, 1.15, 1],
		rotate: [0, 8, -8, 0],
		transition: {
			duration: 0.5,
		},
	},
};

export interface SparklesIconHandle {
	startAnimation: () => void;
	stopAnimation: () => void;
}

interface SparklesIconProps extends MotionProps {
	size?: number;
}

const SparklesIcon = forwardRef<SparklesIconHandle, SparklesIconProps>(
	({ size = 28, ...props }, ref) => {
		const [isAnimating, setIsAnimating] = React.useState(false);

		const startAnimation = () => {
			if (isAnimating) return;
			setIsAnimating(true);
		};

		const stopAnimation = () => {
			setIsAnimating(false);
		};

		useImperativeHandle(ref, () => ({
			startAnimation,
			stopAnimation,
		}));

		return (
			<motion.svg
				width={size}
				height={size}
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				xmlns="http://www.w3.org/2000/svg"
				variants={sparklesVariants}
				animate={isAnimating ? "animate" : "normal"}
				onAnimationComplete={() => setIsAnimating(false)}
				{...props}
			>
				<title>Sparkles</title>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={1.5}
					d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
				/>
				<path strokeLinecap="round" strokeLinejoin="round" d="M20 3v4" />
				<path strokeLinecap="round" strokeLinejoin="round" d="M22 5h-4" />
				<path strokeLinecap="round" strokeLinejoin="round" d="M4 17v2" />
				<path strokeLinecap="round" strokeLinejoin="round" d="M5 18H3" />
			</motion.svg>
		);
	},
);

SparklesIcon.displayName = "SparklesIcon";

export default SparklesIcon;
